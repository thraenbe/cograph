# The PR Tour: a commercial component

CoGraph is open source under the [MIT licence](LICENSE). Builds of CoGraph that the copyright holder
publishes on the Visual Studio Marketplace and Open VSX also contain one component that is not open
source:

| | |
|---|---|
| Component | **CoGraph PR Tour**: the guided tour of a pull request or branch in the browser, its security check and its narration |
| Package | `@thraenbe/pr-tour`, shipped compiled in the extension under `dist/tour/`, with its licence notice in `dist/tour/LICENSE` |
| Owner | Bela Thrän, © 2026, all rights reserved |
| Source | Private. It is not part of this repository and is not published |
| Licence | Proprietary, all rights reserved. It may be used as part of the official CoGraph build it ships in. Copying, modifying or redistributing it, or any part of it, needs the owner's prior written permission. The full terms are in `dist/tour/LICENSE` |

Everything in this repository, including the button that starts a tour, the browser view it runs
in and the interface the component plugs into (`docs/tour-protocol.md`), stays MIT. A build made
from this repository does not contain the component: the tour buttons are hidden, and the rest of
CoGraph works the same.

Questions about the licence: open an issue at https://github.com/thraenbe/cograph/issues or write
to the owner.
