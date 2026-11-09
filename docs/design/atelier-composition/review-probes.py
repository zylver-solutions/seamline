"""Read-only behavioral probes for the accompanying architecture review.

Run: ATELIER_APP_DIR=<application checkout> COMPANION_RUNTIME_DIR=<companion runtime checkout>
     python3 docs/design/atelier-composition/review-probes.py
Both source trees were unpublished when the review was written; the probes need them.
These characterize existing behavior; they are not production conformance tests.
"""
import json
import os
from pathlib import Path
import subprocess
import sys

sys.dont_write_bytecode = True
APP_DIR = Path(os.environ["ATELIER_APP_DIR"]) / "packages/atelier"
sys.path.insert(0, os.environ["COMPANION_RUNTIME_DIR"])
import sim
import scene
import wardrobe

node = subprocess.run(
    ["node", "--experimental-strip-types", "--input-type=module", "-e", """
import { runCouncil } from './src/lib/council.ts';
const report = runCouncil({title: 'The Cup', rule: 'anything', sections: [{
  title: 'The Cup', prose: 'Words '.repeat(41), valueChange: 'absent → present',
  imagePrompt: 'x'.repeat(32), locationHint: 'kitchen'
}]});
console.log(JSON.stringify({ok: report.ok, allSeatsPass: report.verdicts.every(v => v.pass),
  continuityClaim: report.verdicts.find(v => v.seat === 'Continuity / VFX').finding}));
"""],
    cwd=APP_DIR, text=True, capture_output=True, check=True,
)
report = {"council_accepts_meaningless_content": json.loads(node.stdout)}
assert report["council_accepts_meaningless_content"]["allSeatsPass"]

report["in_frame_lod"] = {
    "place": sim.lod_for_place("bedroom", first_plane=True),
    "npc": sim.lod_npc("lili", yuki_place="bedroom", plane="first", mentioned=True),
}
assert report["in_frame_lod"] == {"place": 2, "npc": 0}

current = {"place": "bedroom"}
scene.merge_objects(current, scene.PLACE_OBJECTS["bedroom"])
current["place"] = "kitchen"
scene.merge_objects(current, scene.PLACE_OBJECTS["kitchen"])
report["scene_object_merge_after_move"] = current
assert "bed" in current["objects"] and "counter" in current["objects"]

prompt = wardrobe.compose_prompt(identity="a museum guide", scene={"place": "unmapped-museum"})
report["unknown_place_uses_living_background"] = f"BACKGROUND: {wardrobe.PLACE_BG['living']}" in prompt
assert report["unknown_place_uses_living_background"]

world = sim.default_yuki_world()
sim.start_scripted_scene(world, "museum-tour", duration_min=10, place="cafe", activity="tour")
for ts in (1700000000, 1700003600):
    sim.tick_second(world, ts, 1, in_scene=False)
report["scripted_scene_without_elapsed_min"] = {
    key: world["scripted_scene"][key] for key in ("active", "remaining_min", "applied")
}
assert report["scripted_scene_without_elapsed_min"] == {
    "active": True, "remaining_min": 10, "applied": False,
}

print(json.dumps(report, indent=2, sort_keys=True))
