import { WASI } from 'node:wasi';
import { Worker, threadId, parentPort,/* workerData, */ } from 'node:worker_threads';
const namespaces = {};
const MAX_UINT32 = Math.pow(2, 32) - 1;
const MAX_INT32 = Math.pow(2, 31) - 1;
const MIN_INT32 = -Math.pow(2, 31);
const randomId = () => Math.floor(Math.random() * MAX_UINT32).toString(36);
/**
 *Both main thread and created workers will have this wrapper instance
 *
 * @class WrapperInstance
 */
class WrapperInstance {
	namespace;
	role;				//"wasi_main" or "wasi_helper" or "wasi_worker"
	atomicArray;		//for all roles
	wasiOptions;		//for "wasi_main" and "wasi_worker"
	wasmModule;			//for "wasi_main" and "wasi_worker"
	memory;				//for "wasi_main" and "wasi_worker"
	helperWorkerPort;	//for "wasi_main" and "wasi_worker"
	helperWorker;		//for "wasi_main"
	threadWorkers = [];	//for "wasi_helper"
	threadFile;			//for "wasi_helper"
	constructor(namespace, role) {
		this.namespace = namespace;
		this.role = role;
	}
	findWaitIdx() {//find the first available index in atomicArray
		const array = this.atomicArray;
		//the first unit in array is used to store the current rolling id
		while (true) {
			const i = Atomics.add(array, 0, 1);
			if (i > array.length - 1) {//the old value out of range,reset the index to head:1
				Atomics.compareExchange(array, 0, i + 1, 1);
				continue;
			}
			if (Atomics.compareExchange(array, i, 0, MIN_INT32) === 0) {
				return i;
			}
		}
	}
	releaseWaitIdx(idx) {//release the atomicArray position
		Atomics.store(this.atomicArray, idx, 0);
	}
	waitAtIdx(idx, timeout = 100) {
		const array = this.atomicArray;
		threadDebug('waiting at', idx, 'timeout', timeout);
		let stat = Atomics.wait(array, idx, MIN_INT32, timeout);
		if (stat === 'not-equal') {
			throw (new Error('invalid waiting call'));
		}
		const ret = {
			stat,
			code: Atomics.load(array, idx),
		};
		this.releaseWaitIdx(idx);
		return ret;
	}
	finishAtIdx(idx, code = 1) {//value{ 0:empty, MIN_INT32:waiting, 1:default finished, other values are custom }
		threadDebug('done at', idx);
		const array = this.atomicArray;
		if (code === MIN_INT32 || code === 0) throw (new Error(`code ${code} is reserved`));
		Atomics.compareExchange(array, idx, MIN_INT32, code);
		Atomics.notify(array, idx, 1);
	}
	static get(namespace) {
		return namespaces[namespace];
	}
	static create(namespace, role) {
		if (namespaces[namespace]) throw (new Error(`Already initialized as ${namespace}.${namespaces[namespace].role}`));
		return namespaces[namespace] = new WrapperInstance(namespace, role);
	}
	static destroy(namespace) {
		delete namespaces[namespace];
	}
}

function initWrapper(data) {
	const {
		namespace,
		role,
		atomicBuffer, wasmModule, memory,
		wasiOptions, threadFile,
	} = data;
	if (!role || !namespace) throw (new Error('Not a worker created by "wasi helper"'));
	let wrapper = WrapperInstance.create(namespace, role);
	threadDebug(`init role:${role},tid:${threadId}`);
	wrapper.wasmModule = wasmModule;
	if (!wrapper.wasmModule) throw (new Error('wasmModule not found'));
	wrapper.atomicArray = new Int32Array(atomicBuffer);
	wrapper.memory = memory;
	wrapper.wasiOptions = wasiOptions;
	wrapper.threadFile = threadFile;
	return wrapper;
}
function initThreadData(worker, role, wrapperData, extraData = {}) {
	const {
		namespace,
		atomicArray,
		memory,
		wasmModule,
		wasiOptions,
		threadFile,
	} = wrapperData;
	worker.postMessage({
		namespace,
		opt: 'initThreadData',
		data: {
			namespace,
			role,
			wasiOptions,
			atomicBuffer: atomicArray.buffer,
			wasmModule,
			memory,
			threadFile,
			...extraData
		}
	});
}

async function initWasi(wrapper, data, configFunc) {
	const {
		namespace,
		role,
	} = wrapper;
	const {
		destroy,
		initMethod,//for wasi_main
		wasiOptions,//for wasi_main and wasi_worker
		instanceAddr,//for wasi_worker
	} = data;
	if (!role || !namespace) throw (new Error('Not a worker created by "wasi helper"'));
	let {
		//(optional) additional importObject for WebAssembly.instantiate method
		wasmImports = {},

		//(optional) custom wasi instance,if presented,wasiOptions from initWasiMain config will be ignored
		wasi,

		//(optional) do not run "wasi.start" on the instance
		noWasiStart = false,
	} = configFunc ? await configFunc(namespace, role) : {};
	if (!wasi && !wasiOptions) throw (new Error('wasiOptions or wasi is required'));
	if (wasi && wasiOptions) throw (new Error('wasiOptions and wasi can not be both provided'));

	const isWasiMain = (role === 'wasi_main');
	const isWasiWorker = (role === 'wasi_worker');

	// init wasi, see: 
	// https://github.com/WebAssembly/wasi-threads
	// https://nodejs.org/docs/latest-v20.x/api/wasi.html#new-wasioptions
	if (!wasi)
		wasi = new WASI({ ...wasiOptions });
	const importObject = {
		wasi,
		...wasi.getImportObject(),
	};
	deepAssign(importObject, wasmImports);
	importObject.wasi["thread-spawn"] = (instanceAddr) => {
		//instanceAddr is the parameter to pass to wasi_thread_start, representing the memory address of a new thread instance entry
		//According to the wasi standard, a thread-spawn function needs to be provided for the instance to start a new thread
		//PostMessage to the main process to create a new worker and use an Atomic lock to wait for the result
		const waitAt = wrapper.findWaitIdx();
		if (waitAt === undefined) throw (new Error('cannot get a waiting index'));
		wrapper.helperWorkerPort.postMessage({ namespace, opt: 'createThread', instanceAddr, waitAt });
		const result = wrapper.waitAtIdx(waitAt, 1000);
		if (result.stat !== 'ok' || result.code < 0) throw (new Error(`thread-spawn failed: ${result.stat}, code:${result.code}`));
		return result.code;//return the thread id
	};
	const instance = await WebAssembly.instantiate(wrapper.wasmModule, { env: { memory: wrapper.memory }, ...importObject });
	wrapper.helperWorkerPort.postMessage({
		namespace,
		opt: 'threadReady',
	});
	threadDebug(isWasiMain ? `==== starting wasi_main ==== ` : `==== starting wasi_worker: instanceAddr:${instanceAddr} ==== `);
	if (isWasiMain) {
		if (!noWasiStart) wasi.start(instance);//when "wasiOptions.returnOnExit" is true, nodejs requires wasi.start to be executed
		if (initMethod && instance.exports[initMethod]) {//the extra initMethod
			instance.exports[initMethod]();
		}
	} else if (isWasiWorker) {
		if (!noWasiStart) wasi.start(instance);//when "wasiOptions.returnOnExit" is true, nodejs requires wasi.start to be executed
		let { wasi_thread_start } = instance.exports;
		wasi_thread_start(threadId, instanceAddr);
	} else {
		throw (new Error('Unknown role'));
	}
	threadDebug(`**** ending thread **** `);
	return instance;//return the wasm instance
}


/* for main js thread */
/**
 *
 *
 * @export
 * @param {{
 * 	entryFile : string,			//the js file that initializes the main wasm thread
 * 	threadFile? : entryFile,	//(optional) the js file that initializes the worker wasm thread,can be the same as entryFile
 * 	initMethod? : '',			//(optional) if you have an alternative main thread entry exposed,set the name here
 * 	namespace? : 'wasm_+randomId()',//(optional) the wasm namespace, used to distinguish different wasm instances
 * 	wasmFile? : string|Buffer,	//(optional) alternative to "wasmModule",the wasm file path or buffer
 * 	wasmModule? : WasmModule,	//(optional) alternative to "wasmFile"
 * 	wasiOptions? : {			//(optional) the wasi options, more options see https://nodejs.org/api/wasi.html
 * 		args: [],
 * 		env: {},
 * 		version: 'preview1'
 * 	},
 * 	memorySetting? : {			//(optional) see https://developer.mozilla.org/docs/WebAssembly/JavaScript_interface/Memory
 * 		initial: 512,
 * 		maximum: 4096,
 * }
 * }} config
 * @param {function(namespace,role):{
 * 	wasmImports? : {},		//(optional) additional importObject for WebAssembly.instantiate method
 *	wasi? : WASI,			//(optional) custom wasi instance,if presented,wasiOptions from main thread will be ignored
 *	noWasiStart? : false,	//(optional) do not run wasi.start on the instance
 * }} wasiConfigFunc
 */
export async function initWasiMain({
	//the js file that initializes the wasm main thread
	entryFile,

	//(optional) the js file that initializes the wasm worker thread,can be the same as entryFile
	threadFile = entryFile,

	//(optional) if you have an additional main thread entry exposed,set the name here
	initMethod = '',

	//(optional) the wasm namespace, used to distinguish different wasm instances
	namespace = 'wasm_' + randomId(),

	//(optional) alternative to "wasmModule",the wasm file path or buffer
	wasmFile,

	//(optional) alternative to "wasmFile"
	wasmModule,

	//(optional) the wasi options, see https://nodejs.org/api/wasi.html
	wasiOptions = {
		args: [],
		env: {},
		version: 'preview1'
	},

	//(optional) see https://developer.mozilla.org/docs/WebAssembly/JavaScript_interface/Memory
	memorySetting = {
		initial: 512,
		maximum: 4096,
		//share:true,will be add automatically
	}
} = configObj,
	wasiConfigFunc) {
	return new Promise(async (instanceCreateDone, instanceCreateFail) => {
		if (namespaces[namespace]) throw (new Error(`Already initialized as ${namespace}.${namespaces[namespace].role}`));
		if (!wasmFile) throw (new Error('wasmFile is required'));
		const role = 'wasi_main';
		//if wasmFile is a file path,read it as a buffer
		if (typeof wasmFile === 'string') {
			const fs = await import('node:fs');
			wasmFile = fs.readFileSync(wasmFile);
		}
		wasmModule = (wasmModule || await WebAssembly.compile(wasmFile));
		const wrapper = initWrapper({
			namespace,
			role,
			atomicBuffer: (new WebAssembly.Memory({//get 1 page
				initial: 1,
				maximum: 1,
				shared: true,
			})).buffer,
			memory: new WebAssembly.Memory({
				...memorySetting,
				shared: true,
			}),
			wasmModule,
			wasiOptions,
			threadFile,
		});
		wrapper.atomicArray[0] = 1;// init rolling id index
		if (wrapper.atomicArray.length >= MAX_INT32) {
			throw (new Error(`Atomic array length ${wrapper.atomicArray.length} is too large, must be less than ${MAX_INT32}`));
		}
		const helperWorker
			= wrapper.helperWorkerPort
			= wrapper.helperWorker
			= new Worker('./helper.mjs', {
				stdout: false,
				stderr: false,
			});
		function destroy() {
			if (!wrapper) return;
			if (!WrapperInstance.get(wrapper.namespace)) {
				throw (new Error(`Namespace ${wrapper.namespace} not found`));
			}
			wrapper.helperWorkerPort.postMessage({
				namespace: wrapper.namespace,
				opt: 'destroy',
			});
			WrapperInstance.destroy(wrapper.namespace);
		}
		async function startWasi() {
			try {
				const instance = await initWasi(wrapper, { destroy, initMethod, wasiOptions }, wasiConfigFunc);
				instance.destroyThreadPool = destroy;
				instanceCreateDone(instance);
			} catch (err) {
				instanceCreateFail(err);
			}
		}
		initThreadData(helperWorker, 'wasi_helper', wrapper);
		helperWorker.on('message', msg => {
			if (typeof msg !== 'object' || (msg.namespace !== namespace)) return;
			switch (msg.opt) {
				case 'helperReady':
					startWasi();
					break;
			}
		}).on('error', err => {
			console.log('helperWorker error', err);
		});
	});
}
/**
 * init for worker threads
 * @export
 * @param {function(namespace,role):{
 * 	wasmImports? : {},		//(optional) additional importObject for WebAssembly.instantiate method
 *	wasi? : WASI,			//(optional) custom wasi instance,if presented,wasiOptions from main thread will be ignored
 *	noWasiStart? : false,	//(optional) do not run wasi.start on the instance
 * }} wasiConfigFunc
 * @returns {Promise<wasmModule>}  
 */
export async function initWasiWorker(wasiConfigFunc) {
	return new Promise((instanceCreateDone, instanceCreateFail) => {
		threadDebug(`thread started`);
		let wrapper;
		parentPort.addListener('message', handleMessage);
		async function handleMessage(msg) {
			// threadDebug('msg from main', msg);
			if (typeof msg !== 'object' || (wrapper?.namespace && (msg.namespace !== wrapper.namespace))) return;
			switch (msg.opt) {
				case 'initThreadData'://初始化数据
					wrapper = initWrapper(msg.data);
					if (wrapper.role === 'wasi_worker') {
						wrapper.helperWorkerPort = parentPort;
						try {
							const instance = await initWasi(wrapper, { destroy, ...msg.data }, wasiConfigFunc);
							instanceCreateDone(instance);
						} catch (err) {
							instanceCreateFail(err);
						}
					} else if (wrapper.role === 'wasi_helper') {
						helperMessages(parentPort);
						parentPort.postMessage({
							namespace: wrapper.namespace,
							opt: 'helperReady',
						})
					}
					break;
				case 'destroy':
					destroy();
					break;
			}
		}

		function destroy() {
			if (!wrapper) return;
			WrapperInstance.destroy(wrapper.namespace);
			parentPort.removeListener('message', handleMessage);
		}
		function createThread(args) {//wasi_helper
			const role = 'wasi_worker';
			const { waitAt, instanceAddr } = args;
			const threadWorker = new Worker(wrapper.threadFile);
			threadWorker.role = role;
			threadWorker.waitAt = waitAt;
			wrapper.threadWorkers.push(threadWorker);
			initThreadData(threadWorker, role, wrapper, { instanceAddr });
			helperMessages(threadWorker);
			threadWorker.once('exit', (code) => {
				threadDebug('wasi_worker exit');
				const idx = wrapper.threadWorkers.indexOf(threadWorker);
				if (idx > -1) wrapper.threadWorkers.splice(idx, 1);
			});
		}
		function helperMessages(worker) {//receive worker messages
			function handle(msg) {
				// threadDebug('msg from worker', msg);
				switch (msg.opt) {
					case 'createThread':
						createThread({
							instanceAddr: msg.instanceAddr,
							waitAt: msg.waitAt,
						});
						break;
					case 'threadReady':
						if (worker.waitAt) wrapper.finishAtIdx(worker.waitAt, worker.threadId);
						worker.waitAt = 0;
						break;
					case 'destroy':
						for (let w of wrapper.threadWorkers) {
							w.postMessage({
								namespace: wrapper.namespace,
								opt: 'destroy',
							});
						}
						worker.removeListener('message', handle);
						break;
				}
			}
			worker.on('message', handle);
		}
	});
}

/* function portPair() {
	const channel = new MessageChannel();
	return [channel.port1, channel.port2];
} */
function deepAssign(target, source) {
	for (let key in source) {
		if (typeof source[key] === 'object' && source[key] !== null) {
			if (typeof target[key] !== 'object' || target[key] === null) {
				target[key] = {};
			}
			deepAssign(target[key], source[key]);
		} else {
			target[key] = source[key];
		}
	}
	return target;
}
/* process.once('exit', () => {
	threadDebug('thread', threadId, 'exit');
}); */

let debugLog = false;
function threadDebug(...args) {
	if (!debugLog) return;
	let prefix;
	if (threadId === 0) prefix = '[Main]:';
	else prefix = `[Thread ${threadId}]:`;
	console.debug(prefix, ...args);
}
export function switchDebug(bool) {
	debugLog = bool;
}
