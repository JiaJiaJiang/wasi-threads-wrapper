const { isMainThread } = require('node:worker_threads');
(async () => {
	const { initWasiMain, initWasiWorker } = await import('../index.mjs');

	if (isMainThread) {
		await initWasiMain({
			entryFile: __filename,
			wasmFile: __dirname + '/main.wasm',
			initMethod: 'main2',
		});
	} else {
		await initWasiWorker();
	}
})();
