import { randomInt } from "node:crypto";
import { db } from "./db.js";
import { handle } from "./domain.js";

const words = `acorn alder amber archer aspen aster atlas aurora autumn
  azalea basil beacon birch blossom breeze briar brook cedar cherry clover
  cobalt comet coral cosmos cove cricket cypress dahlia dawn delta dune echo
  elder elm ember falcon fern finch flint flora forest fox frost garnet ginger
  glade grove harbour hazel heath heron holly horizon indigo iris ivy jade
  jasmine juniper kestrel kiwi lagoon lake laurel lark lavender leaf lemon
  lilac lily linden lotus luna lynx magnolia maple marigold meadow mercury
  merlin meteor mica mint mist moon moss myrtle nectar nova oak ocean olive
  onyx opal orbit orchid orion otter owl pebble pepper pine plum poppy prism
  quartz raven reed reef river robin rose rowan ruby sage saffron sequoia
  silver sky slate snow solar sorrel sparrow spruce starling stone storm
  summit sun swift terra thistle thyme tide topaz tulip vale velvet venus
  violet willow winter wren zephyr`.split(/\s+/);

export function suggestAgentName() {
  const occupied = new Set(
    (db.prepare("SELECT name FROM handles").all() as { name: string }[]).map(
      (row) => row.name,
    ),
  );
  const available = words.filter(
    (name) => !occupied.has(name) && handle.safeParse(name).success,
  );
  if (available.length) return available[randomInt(available.length)];

  // Continue with pronounceable, letter-only names when the word list is used
  // up. Probe distinct candidates so collisions never impose an agent limit.
  const syllables = [
    "ba",
    "de",
    "fi",
    "ko",
    "la",
    "mi",
    "na",
    "ro",
    "sa",
    "vi",
  ];
  const start = randomInt(1_000_000);
  for (let offset = 0; ; offset++) {
    const name =
      "lu" +
      String(start + offset)
        .split("")
        .map((n) => syllables[Number(n)])
        .join("");
    if (!occupied.has(name) && handle.safeParse(name).success) return name;
  }
}
