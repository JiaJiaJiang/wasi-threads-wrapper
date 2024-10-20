# wasi-threads-wrapper

This is a wrapper library for creating threads in wasm-wasi, allowing normal synchronous calls to create threads in wasm code.

**WHY?** In Javascript, creating a worker is asynchronous, while creating a thread in some programming languages is synchronous. So in the thread that the wasm calls thread-spawn, js cannot complete the operation of creating a worker (because js is blocked by wasm and cannot finish the event loop), so such a thing is needed to indirectly create a thread through inter-thread communication and Atomic lock.

**HOW?** The basic principle is to move the wasm instance which creates threads to a worker, and then the methods provided by this package will call the main js thread to create workers, and use an Atomic lock to wait for the thread to be created.

Now this library is temporarily only available for nodejs.

## Install
```
npm i wasi-threads-wrapper
```

## Usage

It's very simple to use, just need to call the initialization method of this library in the main js thread and the worker entry file. Of course, you can also write everything in the same worker file, like this:

```javascript
(async () => {
	const { initWasiMain, initWasiWorker } = await import('wasi-threads-wrapper');
	const { isMainThread } = require('node:worker_threads');

	if (isMainThread) {//the script is running in the js main thread
		await initWasiMain({
			entryFile: __filename,//set the wasi main thread worker js file, here is still this file
			wasmFile: 'path/to/wasmfile.wasm',//set the wasm file path or buffer
			initMethod: 'main2',// it's the solution for wasi that force you to calling wasi.start(), just make another "main" and leave the origin one empty
		});
	} else {//the script is running in the js worker
		await initWasiWorker();//this method accepts a config function, ses below
	}
})();

```

## Wasm imports and exports

Before using this wrapper, make sure your wasm program has enabled the following features, the wasi instance requires these to work:
* atomics
* shared memory
* import memory
* export memory

## Doc

```javascript
//config for initWasiMain
async function initWasiMain({
	//the js file that initializes the wasm main thread
	entryFile,
	
	//(optional) the js file that initializes the wasm worker thread,can be the same as entryFile
	threadFile = entryFile,

	//(optional) for wasi main thread, if you have an additional main thread entry exposed,set the name here
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
} = configObj)
```

```javascript
//config for initWasiWorker
export async function initWasiWorker(configFunc);

//here is a configFunc example
async function configFunc(namespace, role){
	return {
		//(optional) additional importObject for WebAssembly.instantiate method
		wasmImports = {},
		
		//(optional) set to false if you don't want the namespace be auto destroyed when the entry method ends
		destroyWhenEnd = true,

		//(optional) custom wasi instance,if presented,wasiOptions from main thread will be ignored
		wasi,

		//(optional) do not run wasi.start on the instance
		noWasiStart = false,
	}
}
```