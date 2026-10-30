import { randomInt } from "node:crypto";
import { db } from "./db.js";
import { handle } from "./domain.js";

const words =
  `abalone abelia acacia acorn agate albatross alder alfalfa allium almond alpine
  amaranth amaryllis amber anemone angelica anise antelope apricot aquamarine
  arbutus archer argon arrow ash aspen aster atlas auburn aurora autumn
  avalanche avocet azalea badger bamboo banyan barley basil bay beacon bear
  beech beetle bergamot beryl bilberry birch bison blackberry blackbird blossom
  bluebell blueberry bobcat bonsai borage boulder bracken bramble brass breeze
  briar bronze brook buckeye buffalo bulrush bunting buttercup butterfly
  butternut cacao cactus calendula camellia canary candle canyon caper capybara
  caramel cardinal caribou carnelian carob carp cashew cassia cattail cayenne
  cedar celadon celandine celery cerise chamois chamomile cherry chestnut
  chickadee chicory chinchilla chive cicada cinnamon citrine citron clay
  clematis cloud cloudberry clover coast cobalt cocoa coconut columbine comet
  copper coral coriander cormorant cornflower cosmos cotton cove cranberry crane
  cricket crocus crystal currant custard cypress daffodil dahlia damson
  dandelion dapple dawn deer delphinium delta desert diamond dill dogwood
  dolphin dove dragonfly drift driftwood duck dune dusk eagle earth ebony echo
  eclipse egret eider elder elderberry elephant elk elm ember emerald equinox
  ermine eucalyptus evening evergreen falcon fawn feather fennel fern fig finch
  fir firefly fireweed fjord flamingo fleece flint flora flower fluorite
  foothill forest forgetmenot forsythia fossa fox freesia frost fuchsia galaxy
  garden gardenia garnet gazelle gecko gentian geranium gibbon ginger glacier
  glade gladiolus gleam glimmer glow gneiss goose gossamer granite grape
  graphite grass gravel grebe greenfinch grouse grove guava gull gypsum halcyon
  harbour hare harvest hawk hawthorn hazel heath heather heliotrope hemlock
  heron hibiscus hickory hill holly honey honeybee honeysuckle hoopoe horizon
  huckleberry hummingbird hyacinth ibex ibis ice icecap iguana impala indigo ink
  iolite iris ironwood island ivory ivy jacaranda jackal jackdaw jade jasmine
  jasper jay jellyfish juniper jupiter kestrel kingfisher kite kiwi koala
  kohlrabi kumquat labradorite lace lacewing ladybird lagoon lake lapis lapwing
  larch lark larkspur laurel lava lavender leaf lemming lemon lemur leopard
  lettuce lichen lilac lily lilypad limber lime limpet linden linnet lion litmus
  loam lobelia locust loganberry loon loquat lotus luna lupin lychee lynx
  mackerel magenta magnolia magpie mahogany mallow mandarin mango mangrove
  mantis maple mapleleaf marble marigold marmot mars marten mayfly meadow medlar
  meerkat melon mercury merganser merlin mesa meteor mica midnight milkweed
  mimosa mineral minnow mint mirage mist mochi monarch mongoose moon moonbeam
  moonflower moonlight moonstone moor morning moss mulberry mushroom mussel
  mustard myna myrtle nacre narwhal nasturtium nautilus nectar nectarine nettle
  neutron nightingale nova nutmeg oak obsidian ocean ocelot ochre octopus okapi
  oleander olive olivine onyx opal orbit orchid oregano oriole orion oryx osprey
  otter owl oyster paddock palm panda pansy papaya paprika parchment parrot
  parsnip partridge passionflower pasture peach peacock pear pearl pebble pecan
  pelican penguin penny peony pepper peregrine peridot persimmon petal petrel
  pewter pheasant phlox photon pigeon pika pimento pine pinion pipit pistachio
  planet plantain plateau plover plum polaris polecat pollen pomelo pond poppy
  porcelain porpoise prairie primrose prism privet ptarmigan puffin pumice
  pumpkin quail quartz quince rabbit raccoon rain rainbow raindrop rainforest
  raisin rapids raspberry raven redbud redstart redwood reed reef reindeer
  rhubarb ridge rill ripple river roadrunner robin rock rocket rook rose
  rosemary rosewood rowan ruby russet rutile sable saffron sage sail salmon salt
  sand sandalwood sandpiper sapphire sardine satin savanna scallop scarlet
  scoter seabird seahorse seal seashell sedge seedling selene sepia sequoia
  seraph serpentine sesame shale shamrock shell shrew sienna silk silver siskin
  skua sky skylark slate snapdragon snipe snow snowberry snowdrop snowflake
  snowshoe soapstone solar solstice songbird sorbet sorghum sorrel southerly
  sparrow spearmint sphene spice spinach spindle spoonbill spring springbok
  spruce squirrel star starfish starlight starling stilt stone storm strawberry
  stream sugar sumac summit sun sunflower sunrise sunset swallow sweetpea swift
  sycamore tangerine tansy tapir teak teal tempest tern terra terracotta thicket
  thistle thrush thunder thyme tide tiger timber titmouse topaz tortoise toucan
  tourmaline trail tree trillium trout truffle tulip tundra turquoise turtle
  twilight umber urchin vale valley vanilla velvet venus verbena verdant vervain
  vesper vetch vine viola violet vireo vista vole walnut warbler watercress
  waterfall wave waxwing weasel wheat whimbrel whisper wildflower willow wind
  windflower wing winter wisteria wolf wolfram wombat woodbine woodcock woodlark
  wren yarrow yellowhammer yew yucca zephyr zinnia zircon`.split(/\s+/);

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
