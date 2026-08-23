import { runLocalMindScaleBenchmark } from "./lib/mind-scale-benchmark.mjs";

const report = await runLocalMindScaleBenchmark();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
