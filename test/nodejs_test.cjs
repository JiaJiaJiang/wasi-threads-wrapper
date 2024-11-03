const { isMainThread } = require('node:worker_threads');
(async () => {
	const { initWasiMain, initWasiWorker,switchDebug } = await import('../index.mjs');
	switchDebug(true);
	if (isMainThread) {
		const wasm=await initWasiMain({
			entryFile: __filename,
			wasmFile: __dirname + '/poolTest.wasm',
			// initMethod: 'main2',
		});
		wasm.exports.test();
		wasm.destroyThreadPool();
		// process.exit(0);
	} else {
		await initWasiWorker();
	}
})();
