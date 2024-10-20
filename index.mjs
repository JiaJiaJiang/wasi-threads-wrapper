import { WASI } from 'node:wasi';
import { Worker, threadId, workerData, parentPort } from 'node:worker_threads';
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
	role;				//"wasi_main" or "wasi_worker"
	atomicArray;		//for all WrapperInstance,created by js main thread
	wasmModule;			//for all wasi workers,created by js main thread
	memory;				//for all wasi workers,created by js main thread
	mainWorker;			//for js main thread
	threadWorkers = [];	//for js main thread
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
		const o = {
			stat,
			code: Atomics.load(array, idx),
		};
		this.releaseWaitIdx(idx);
		return o;
	}
	finishAtIdx(idx, code = 1) {//value{ 0:empty, MIN_INT32:waiting, 1:default finished, other values are custom }
		// threadDebug('done at', idx);
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
} = configObj) {
	if (namespaces[namespace]) throw (new Error(`Already initialized as ${namespace}.${namespaces[namespace].role}`));
	if (!wasmFile) throw (new Error('wasmFile is required'));
	const role = 'wasi_main';
	//if wasmFile is a file path,read it as a buffer
	if (typeof wasmFile === 'string') {
		const fs = await import('node:fs');
		wasmFile = fs.readFileSync(wasmFile);
	}
	const wrapper = WrapperInstance.create(namespace, role);
	wrapper.memory = new WebAssembly.Memory({
		...memorySetting,
		shared: true,
	});
	wasmModule = wrapper.wasmModule = (wasmModule || await WebAssembly.compile(wasmFile));
	const sharedBuffer =
		(new WebAssembly.Memory({//get 1 page
			initial: 1,
			maximum: 1,
			shared: true,
		})).buffer;
	wrapper.atomicArray = new Int32Array(sharedBuffer);
	wrapper.atomicArray[0] = 1;
	if (wrapper.atomicArray.length >= MAX_INT32) {
		throw (new Error(`Atomic array length ${wrapper.atomicArray.length} is too large, must be less than ${MAX_INT32}`));
	}
	const mainWorker = wrapper.mainWorker = new Worker(entryFile);
	mainWorker.role = role;
	initThreadData(mainWorker, role);
	handleWorker(mainWorker);

	function initThreadData(worker, role, extraData = {}) {
		worker.postMessage({
			namespace,
			opt: 'initThreadData',
			data: {
				namespace,
				role,
				wasiOptions,
				atomicBuffer: wrapper.atomicArray.buffer,
				wasmModule,
				memory: wrapper.memory,
				initMethod,
				...extraData
			}
		});
	}
	function handleWorker(worker) {//receive worker messages
		worker.on('message', msg => {
			// threadDebug('msg from worker', msg);
			if (typeof msg !== 'object' || msg?.namespace !== namespace) return;
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
			}
		});
		worker.on('exit', (code) => {
			if (worker.role === 'wasi_main') {
				threadDebug('wasi_main exit');
				wrapper.mainWorker = null;
				WrapperInstance.destroy(namespace);
				//let thread workers destroy if wasi_main exits
				for (let w of wrapper.threadWorkers) {
					w.postMessage({
						namespace,
						opt: 'destroy'
					});
				}
			} else {
				threadDebug('wasi_worker exit');
				const idx = wrapper.threadWorkers.indexOf(worker);
				if (idx > -1) wrapper.threadWorkers.splice(idx, 1);
			}
		});
	}
	function createThread(args) {
		const role = 'wasi_worker';
		const { waitAt, instanceAddr } = args;
		const threadWorker = new Worker(threadFile);
		threadWorker.role = role;
		threadWorker.waitAt = waitAt;
		wrapper.threadWorkers.push(threadWorker);
		initThreadData(threadWorker, role, { instanceAddr });
		handleWorker(threadWorker);
	}
}
/**
 * init for worker threads
 * @export
 * @param {function(namespace,role):{
 * 	wasmImports? : {},		//(optional) additional importObject for WebAssembly.instantiate method
 *	destroyWhenEnd? : true,	//(optional) set to false if you don't want the namespace be auto destroyed when the entry method ends
 *	wasi? : WASI,			//(optional) custom wasi instance,if presented,wasiOptions from main thread will be ignored
 *	noWasiStart? : false,	//(optional) do not run wasi.start on the instance
 * }} configFunc
 * @returns {Promise<wasmModule>}  
 */
export async function initWasiWorker(configFunc) {
	threadDebug(`thread started`);
	let wrapper;
	let instanceCreateDone, instanceCreateFail;
	parentPort.addListener('message', handleMessage);
	async function handleMessage(msg) {
		// threadDebug('msg from main', msg);
		if (typeof msg !== 'object' || (wrapper?.namespace && (msg.namespace !== wrapper.namespace))) return;
		switch (msg.opt) {
			case 'initThreadData'://初始化数据
				try {
					const instance = await initWasi(msg.data);
					instanceCreateDone(instance);
				} catch (err) {
					instanceCreateFail(err);
				}
				break;
			case 'destroy':
				destroy();
		}
	}

	async function initWasi(data) {
		const {
			namespace,
			role,
			initMethod,//for wasi_main
			wasiOptions,//for wasi_main and wasi_worker
			atomicBuffer, wasmModule, memory,//for wasi_main and wasi_worker
			instanceAddr,//for wasi_worker
		} = data;
		if (!role || !namespace) throw (new Error('Not a worker created by "initWasiMain"'));
		let {
			//(optional) additional importObject for WebAssembly.instantiate method
			wasmImports = {},

			//(optional) set to false if you don't want the namespace to be auto destroyed when the entry method ends
			destroyWhenEnd = true,

			//(optional) custom wasi instance,if presented,wasiOptions from initWasiMain config will be ignored
			wasi,

			//(optional) do not run "wasi.start" on the instance
			noWasiStart = false,
		} = configFunc ? await configFunc(namespace, role) : {};
		if (!wasi && !wasiOptions) throw (new Error('wasiOptions or wasi is required'));
		if (wasi && wasiOptions) throw (new Error('wasiOptions and wasi can not be both provided'));
		wrapper = WrapperInstance.create(namespace, role);
		threadDebug(`init role:${role},tid:${threadId}`);
		const isWasiMain = (role === 'wasi_main');
		const isWasiWorker = (role === 'wasi_worker');
		wrapper.atomicArray = new Int32Array(atomicBuffer);
		wrapper.wasmModule = wasmModule;
		wrapper.memory = memory;
		if (!wrapper.wasmModule) throw (new Error('wasmModule not found'));
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
			parentPort.postMessage({ namespace, opt: 'createThread', instanceAddr, waitAt });
			const result = wrapper.waitAtIdx(waitAt, 1000);
			if (result.stat !== 'ok' || result.code < 0) throw (new Error(`thread-spawn failed: ${result.stat}, code:${result.code}`));
			return result.code;//return the thread id
		};
		const instance = await WebAssembly.instantiate(wrapper.wasmModule, { env: { memory: wrapper.memory }, ...importObject });
		parentPort.postMessage({
			namespace,
			opt: 'threadReady',
		});
		threadDebug(isWasiMain ? `==== starting wasi_main ==== ` : `==== starting wasi_worker: instanceAddr:${instanceAddr} ==== `);
		let { wasi_thread_start } = instance.exports;
		if (isWasiMain) {
			if (!noWasiStart) wasi.start(instance);//when "wasiOptions.returnOnExit" is true, nodejs requires wasi.start to be executed
			if (initMethod && instance.exports[initMethod]) {//the extra initMethod
				instance.exports[initMethod]();
			}
		} else if (isWasiWorker) {
			if (!noWasiStart) wasi.start(instance);//when "wasiOptions.returnOnExit" is true, nodejs requires wasi.start to be executed
			wasi_thread_start(threadId, instanceAddr);
		} else {
			throw (new Error('Unknown role'));
		}
		threadDebug(`**** ending thread`);
		if (destroyWhenEnd) {
			destroy();
		}
		return instance;//return the wasm instance
	}
	function destroy() {
		if (!wrapper) return;
		WrapperInstance.destroy(wrapper.namespace);
		parentPort.removeListener('message', handleMessage);
	}
	return new Promise((ok, fail) => {
		instanceCreateDone = ok;
		instanceCreateFail = fail;
	});
}
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