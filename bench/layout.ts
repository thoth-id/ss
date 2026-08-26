// headless layout verification of the real client, over CDP.
//
// the tile fit is computed in px by layout(), not by the CSS, so touching the
// shell can break it silently: the assertion that matters is that the page
// never scrolls. this script starts Chrome, opens the real client and injects
// fake sharers into attachTile() with canvas.captureStream(). everything in the
// client script is global, so the path exercised is the production one, aspect
// ratios included.
//
// needs a live server, in one command, because a background process from
// another invocation does not survive:
//
//   (PORT=3200 STUN_PORT=3678 bun run server.ts > /tmp/s.log 2>&1 & echo $! > /tmp/p); \
//     sleep 2; bun run bench/layout.ts; kill $(cat /tmp/p)
//
// real WebRTC stays out of reach here: no remote browser, no second machine.
// this covers layout, presence, the gate and switching rooms. same variables
// test.ts honours, so a run can dodge a server that is already up.
import { cdp, closeCdp, connectCdp, evalJS, setViewport } from "./cdp.ts";
import { ensureChrome, killChrome, OUT, PORT } from "./chrome.ts";

import {
	callScenario,
	focusScenario,
	gateScenario,
	narrowScenario,
	roomScenario,
	zoomScenario,
} from "./scenarios.ts";

ensureChrome();

await connectCdp();

await cdp("Page.enable");
await cdp("Runtime.enable");
await setViewport(1440, 900);
await cdp("Page.navigate", { url: `http://127.0.0.1:${PORT}/#room` });
await Bun.sleep(1500);
for (let i = 0; i < 60 && !(await evalJS<boolean>('typeof ROOM !== "undefined"')); i++) {
	await Bun.sleep(250);
}

const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
	console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : `  ${detail}`}`);
	if (!cond) failures.push(name);
}

await gateScenario(check);
await callScenario(check);
await focusScenario(check);
await zoomScenario(check);
await narrowScenario(check);
await roomScenario(check);

console.log(
	failures.length ? `\n${failures.length} FAILURE(S): ${failures.join(", ")}` : "\nall green",
);
closeCdp();
killChrome();
process.exit(failures.length ? 1 : 0);

// keep OUT used so chrome.ts side-effect import is not considered unused by linter
void OUT;
