// Build step: compiles every built-in style once with a recorder attached, and prints the (argName, body) pairs as JSON.
// build.mjs turns them into precompiled functions, so the page also works where `eval` is forbidden.
import { recordFactories } from '../src/core/codeEval';
import { ProfileLibrary } from '../src/profile/library';
import { MaterialLibrary } from '../src/surface/materialLibrary';
import { BridgeLibrary } from '../src/structures/library';
import { WaterLibrary } from '../src/water/styleLibrary';

const pairs: Array<[string, string]> = [];
recordFactories((a, b) => pairs.push([a, b]));
const p = new ProfileLibrary();
const m = new MaterialLibrary();
const b = new BridgeLibrary();
const w = new WaterLibrary();
// resolving compiles the params schema / build function paths too, but the factories are what we need
void p; void m; void b; void w;
process.stdout.write(JSON.stringify(pairs));
