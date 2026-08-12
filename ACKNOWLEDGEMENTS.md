# Acknowledgements

hunktastic builds directly on the work of others.

- **[hunk](https://github.com/modem-dev/hunk)** by Ben Vinegar and the Modem team (MIT). hunktastic is a fork of hunk. The review TUI, the agent annotation session model, and most of the code in this repository are theirs. Upstream lives at [hunk.dev](https://hunk.dev).
- **[difftastic](https://github.com/Wilfred/difftastic)** by Wilfred Hughes (MIT). The structural diff engine this fork integrates. Consumed as the `difft` binary, not vendored. difftastic itself vendors tree-sitter grammars under their own MIT and Apache-2.0 licenses.
- **[OpenTUI](https://github.com/anomalyco/opentui)** and **[@pierre/diffs](https://www.npmjs.com/package/@pierre/diffs)**: the terminal UI framework and the line-diff engine hunk is built on.

The original MIT license and copyright notice are retained in [LICENSE](LICENSE).
