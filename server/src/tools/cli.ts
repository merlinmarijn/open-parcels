/** Where a tool writes: its report to `out`, notices to `err`. Tests pass their own. */
export interface ToolOutput {
  out(text: string): void;
  err(text: string): void;
}

export type ToolMain = (argv: readonly string[], output: ToolOutput) => Promise<void>;

const processOutput: ToolOutput = {
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
};

/** Runs a tool with the process's arguments; a failure prints `failure: message` and exits 1. */
export function runTool(failure: string, main: ToolMain): void {
  main(process.argv.slice(2), processOutput).catch((error: unknown) => {
    process.stderr.write(`${failure}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
