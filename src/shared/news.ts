/** An item from a public feed (RSS, Atom or JSON Feed), as shown in the Feed. */
export type NewsStory = {
  id: string;
  title: string;
  url: string;
  /** The linked site, or null for Ask HN, self posts and other posts on the source. */
  site: string | null;
  comments_url: string | null;
  published_at: number | null;
  /** Where it was posted, such as "r/programming"; null on Hacker News. */
  community: string | null;
  author: string | null;
  points: number | null;
  comments: number | null;
  /** A plain-text excerpt of the item, or null when it only has a title. */
  summary: string | null;
  /** A picture the feed offered for the item, always https, or null. */
  image: string | null;
  /** An audio or video enclosure: where it is, its type and its length. */
  media: { url: string; type: string; seconds: number | null } | null;
};

/** A story as Social shows it: with the feed it came from, and when it arrived. */
export type SocialStoryFields = {
  feed: string;
  /** When Loop55 first read this story, which undated feeds are sorted by. */
  first_seen_at: number;
  /** Whether you have opened, asked about or marked this story. */
  read: boolean;
};

/** A story in Social, with the catalog feed it came from. */
export type SocialStory = NewsStory & SocialStoryFields;

export type SocialResponse = {
  stories: SocialStory[];
  /** The feeds you added that couldn't be loaded and had no earlier copy. */
  failed: string[];
  /** Feeds still being read, with nothing to show yet: ask again shortly. */
  pending: string[];
  /** When the newest copy in this list was read. */
  fetched_at: number;
  /** What each added feed last did, so a quiet feed can say why. */
  feeds: FeedHealth[];
  /** Stories you haven't read, as the Social chip's count, at most 99. */
  unread: number;
  /** Stories kept out of this list by a word you hid. */
  hidden: number;
};

/** When a feed was last read, and what went wrong if it could not be. */
export type FeedHealth = {
  id: string;
  fetched_at: number | null;
  failed_at: number | null;
  error: string | null;
  stories: number;
};

/**
 * The same article posted to two feeds is one story, so links that differ only
 * in how they were shared are one address: no tracking parameters, no
 * fragment, no trailing slash.
 */
export function sameStoryUrl(url: string) {
  try {
    const at = new URL(url);
    at.hash = "";
    for (const name of [...at.searchParams.keys()])
      if (/^(utm_|ref$|ref_|fbclid$|gclid$|mc_cid$|mc_eid$|at_)/i.test(name))
        at.searchParams.delete(name);
    at.pathname = at.pathname.replace(/\/+$/, "") || "/";
    return at.href;
  } catch {
    return url;
  }
}

export type FeedEntry = {
  id: string;
  name: string;
  category: string;
  description: string;
  /** The site the feed belongs to, shown on the catalog card. */
  home: string;
  url: string;
  /** The tile colour behind the feed's initial. */
  color: string;
  /** What one item is called on its cards: "story", "post", "article"… */
  kind: string;
  /** The site's own mark on its cards, instead of the feed's initial. */
  mark?: FeedMarkName;
};

/** Sites whose own mark Social draws rather than an initial on a colour. */
export type FeedMarkName = "hn" | "reddit" | "github" | "youtube";

const entry = (
  id: string,
  name: string,
  category: string,
  url: string,
  color: string,
  description: string,
  kind = "article",
  mark?: FeedMarkName,
): FeedEntry => ({
  id,
  name,
  category,
  description,
  home: new URL(url).hostname.replace(/^(www|feeds|rss|blog|export)\./, ""),
  url,
  color,
  kind,
  ...(mark && { mark }),
});
// The feeds Loop55 offers. Each was read with the shared parser before it was
// listed; changing one is a source change. A feed someone adds by address
// (src/server/feed-sources.ts) has no such warrant, so it is validated first —
// public HTTPS, no credentials, never an address on this network — and read
// through the same transport, which resolves DNS through a public-only
// dispatcher and follows redirects only within the feed's own site.
// Reddit is deliberately absent: its logged-out RSS answers 429 from every
// subreddit, and old.reddit.com redirects feeds to a login page.
export const feedCatalog: FeedEntry[] = [
  entry(
    "hackernews",
    "Hacker News",
    "Tech news",
    "https://news.ycombinator.com/rss",
    "#ff6600",
    "The Hacker News front page: links and discussion picked by its readers.",
    "story",
  ),
  entry(
    "hackernews-show",
    "Show HN",
    "Tech news",
    "https://hnrss.org/show",
    "#ff6600",
    "Projects people built and shared on Hacker News, with points and comments.",
    "story",
  ),
  entry(
    "lobsters",
    "Lobsters",
    "Tech news",
    "https://lobste.rs/rss",
    "#ac130d",
    "A computing link site with invitation-only membership and tagged stories.",
    "story",
  ),
  entry(
    "the-verge",
    "The Verge",
    "Tech news",
    "https://www.theverge.com/rss/index.xml",
    "#5200ff",
    "Technology, science and culture news and reviews.",
  ),
  entry(
    "ars-technica",
    "Ars Technica",
    "Tech news",
    "https://feeds.arstechnica.com/arstechnica/index",
    "#ff4e00",
    "In-depth technology, science and policy reporting.",
  ),
  entry(
    "techcrunch",
    "TechCrunch",
    "Tech news",
    "https://techcrunch.com/feed/",
    "#0a8935",
    "Startups, funding and technology industry news.",
  ),
  entry(
    "wired",
    "Wired",
    "Tech news",
    "https://www.wired.com/feed/rss",
    "#000000",
    "How technology is changing culture, business and science.",
  ),
  entry(
    "slashdot",
    "Slashdot",
    "Tech news",
    "https://rss.slashdot.org/Slashdot/slashdotMain",
    "#026664",
    "News for nerds, summarised from around the web.",
    "story",
  ),
  entry(
    "the-register",
    "The Register",
    "Tech news",
    "https://www.theregister.com/headlines.atom",
    "#ff0000",
    "Enterprise technology news, reported without reverence.",
    "story",
  ),
  entry(
    "404-media",
    "404 Media",
    "Tech news",
    "https://www.404media.co/rss/",
    "#111111",
    "Journalist-owned reporting on technology and power.",
    "story",
  ),
  entry(
    "mit-technology-review",
    "MIT Technology Review",
    "Tech news",
    "https://www.technologyreview.com/feed/",
    "#cc0000",
    "What new technology means, from MIT's magazine.",
  ),
  entry(
    "product-hunt",
    "Product Hunt",
    "Tech news",
    "https://www.producthunt.com/feed",
    "#da552f",
    "New products launching today.",
    "launch",
  ),
  entry(
    "hackernews-best",
    "HN Best",
    "Communities",
    "https://hnrss.org/best",
    "#ff6600",
    "The stories Hacker News readers rated highest this week.",
    "story",
    "hn",
  ),
  entry(
    "hackernews-ask",
    "Ask HN",
    "Communities",
    "https://hnrss.org/ask",
    "#ff6600",
    "Questions Hacker News readers put to each other.",
    "story",
    "hn",
  ),
  entry(
    "lobsters-ai",
    "Lobsters: AI",
    "Communities",
    "https://lobste.rs/t/ai.rss",
    "#ac130d",
    "Machine learning links from the Lobsters AI tag.",
    "story",
  ),
  entry(
    "hackernews-points",
    "HN: 100 points",
    "Communities",
    "https://hnrss.org/frontpage?points=100",
    "#ff6600",
    "Front-page stories once they pass a hundred points.",
    "story",
    "hn",
  ),
  entry(
    "tildes",
    "Tildes",
    "Communities",
    "https://tildes.net/topics.atom",
    "#002b36",
    "A small invite-only link aggregator with slow, long discussion.",
    "post",
  ),
  entry(
    "openai-news",
    "OpenAI News",
    "AI",
    "https://openai.com/news/rss.xml",
    "#10a37f",
    "Announcements and research from OpenAI.",
  ),
  // Anthropic publishes no feed: /rss.xml, /news/rss.xml, /news/feed.xml and
  // /engineering/rss.xml all answered 404 in October 2026. Claude Status does
  // have one, under Status.
  entry(
    "simon-willison",
    "Simon Willison",
    "AI",
    "https://simonwillison.net/atom/everything/",
    "#4a6b8a",
    "Notes and links on LLMs, tools and the web, posted daily.",
    "post",
  ),
  entry(
    "arxiv-cs-ai",
    "arXiv: AI",
    "AI",
    "https://export.arxiv.org/rss/cs.AI",
    "#b31b1b",
    "New artificial intelligence papers on arXiv.",
    "paper",
  ),
  entry(
    "deepmind",
    "Google DeepMind",
    "AI",
    "https://deepmind.google/blog/rss.xml",
    "#1a73e8",
    "Research and announcements from Google DeepMind.",
    "post",
  ),
  entry(
    "hugging-face",
    "Hugging Face",
    "AI",
    "https://huggingface.co/blog/feed.xml",
    "#ffd21e",
    "Open models, datasets and tooling from Hugging Face.",
    "post",
  ),
  entry(
    "google-ai",
    "Google AI",
    "AI",
    "https://blog.google/technology/ai/rss/",
    "#4285f4",
    "What Google is shipping and publishing in AI.",
    "post",
  ),
  entry(
    "latent-space",
    "Latent Space",
    "AI",
    "https://www.latent.space/feed",
    "#0f1729",
    "Interviews and essays on building with language models.",
    "post",
  ),
  entry(
    "import-ai",
    "Import AI",
    "AI",
    "https://importai.substack.com/feed",
    "#ff6719",
    "Jack Clark's weekly read of AI research and policy.",
    "post",
  ),
  entry(
    "one-useful-thing",
    "One Useful Thing",
    "AI",
    "https://www.oneusefulthing.org/feed",
    "#8b5cf6",
    "Ethan Mollick on what these models are actually good for.",
    "post",
  ),
  entry(
    "ahead-of-ai",
    "Ahead of AI",
    "AI",
    "https://magazine.sebastianraschka.com/feed",
    "#2563eb",
    "Sebastian Raschka on language model research and training.",
    "post",
  ),
  entry(
    "arxiv-cs-cl",
    "arXiv: Language",
    "AI",
    "https://export.arxiv.org/rss/cs.CL",
    "#b31b1b",
    "New computational linguistics papers on arXiv.",
    "paper",
  ),
  entry(
    "arxiv-cs-lg",
    "arXiv: Learning",
    "AI",
    "https://export.arxiv.org/rss/cs.LG",
    "#b31b1b",
    "New machine learning papers on arXiv.",
    "paper",
  ),
  entry(
    "github-blog",
    "The GitHub Blog",
    "Engineering",
    "https://github.blog/feed/",
    "#24292f",
    "Product updates and engineering from GitHub.",
  ),
  entry(
    "cloudflare-blog",
    "The Cloudflare Blog",
    "Engineering",
    "https://blog.cloudflare.com/rss/",
    "#f38020",
    "Networking, security and infrastructure engineering.",
  ),
  entry(
    "rust-blog",
    "Rust Blog",
    "Engineering",
    "https://blog.rust-lang.org/feed.xml",
    "#ce422b",
    "Releases and news from the Rust project.",
    "post",
  ),
  entry(
    "martin-fowler",
    "Martin Fowler",
    "Engineering",
    "https://martinfowler.com/feed.atom",
    "#2f6f9f",
    "Software design, architecture and delivery.",
  ),
  entry(
    "css-tricks",
    "CSS-Tricks",
    "Engineering",
    "https://css-tricks.com/feed/",
    "#ff7a18",
    "Front-end techniques for CSS, HTML and JavaScript.",
  ),
  entry(
    "dev-to",
    "DEV Community",
    "Engineering",
    "https://dev.to/feed",
    "#0a0a0a",
    "Posts from developers on DEV.",
    "post",
  ),
  entry(
    "go-blog",
    "The Go Blog",
    "Engineering",
    "https://go.dev/blog/feed.atom",
    "#00add8",
    "Releases, design notes and news from the Go team.",
    "post",
  ),
  entry(
    "node-blog",
    "Node.js Blog",
    "Engineering",
    "https://nodejs.org/en/feed/blog.xml",
    "#5fa04e",
    "Node.js releases, security notices and announcements.",
    "post",
  ),
  entry(
    "react-blog",
    "React Blog",
    "Engineering",
    "https://react.dev/rss.xml",
    "#087ea4",
    "Releases and design discussion from the React team.",
    "post",
  ),
  entry(
    "python-insider",
    "Python Insider",
    "Engineering",
    "https://blog.python.org/feeds/posts/default",
    "#3775a9",
    "Releases and announcements from the Python core team.",
    "post",
  ),
  entry(
    "webkit-blog",
    "WebKit",
    "Engineering",
    "https://webkit.org/feed/",
    "#1b7bbb",
    "Browser engine work and new web platform features.",
    "post",
  ),
  entry(
    "chrome-developers",
    "Chrome Developers",
    "Engineering",
    "https://developer.chrome.com/static/blog/feed.xml",
    "#1a73e8",
    "What is new on the web platform, from the Chrome team.",
    "post",
  ),
  entry(
    "changelog",
    "Changelog",
    "Engineering",
    "https://changelog.com/feed",
    "#5fb37c",
    "Conversations with the people building software.",
    "post",
  ),
  entry(
    "julia-evans",
    "Julia Evans",
    "Engineering",
    "https://jvns.ca/atom.xml",
    "#d1365f",
    "Debugging, networking and systems, explained clearly.",
    "post",
  ),
  entry(
    "dan-luu",
    "Dan Luu",
    "Engineering",
    "https://danluu.com/atom.xml",
    "#333333",
    "Long essays on performance, hiring and how teams work.",
    "post",
  ),
  entry(
    "aws-news",
    "AWS News",
    "Engineering",
    "https://aws.amazon.com/blogs/aws/feed/",
    "#ff9900",
    "New AWS services and features as they launch.",
    "post",
  ),
  entry(
    "oxide",
    "Oxide Computer",
    "Engineering",
    "https://oxide.computer/blog/feed",
    "#1b1a1f",
    "Building server hardware and the software that runs it.",
    "post",
  ),
  entry(
    "netflix-tech",
    "Netflix TechBlog",
    "Engineering",
    "https://netflixtechblog.com/feed",
    "#e50914",
    "How Netflix builds and runs its systems at scale.",
    "post",
  ),
  entry(
    "stackoverflow-blog",
    "Stack Overflow Blog",
    "Engineering",
    "https://stackoverflow.blog/feed/",
    "#f48024",
    "Practice, tooling and research from Stack Overflow.",
    "post",
  ),
  entry(
    "phoronix",
    "Phoronix",
    "Engineering",
    "https://www.phoronix.com/rss.php",
    "#a4a71e",
    "Linux hardware support, kernel work and benchmarks.",
    "story",
  ),
  entry(
    "stratechery",
    "Stratechery",
    "Commentary",
    "https://stratechery.com/feed/",
    "#d5683a",
    "Ben Thompson on the strategy and business of technology.",
  ),
  entry(
    "platformer",
    "Platformer",
    "Commentary",
    "https://www.platformer.news/rss/",
    "#1f2e5c",
    "Casey Newton on big tech and democracy.",
  ),
  entry(
    "daring-fireball",
    "Daring Fireball",
    "Commentary",
    "https://daringfireball.net/feeds/json",
    "#4a525a",
    "John Gruber on Apple, technology and design.",
    "post",
  ),
  entry(
    "astral-codex-ten",
    "Astral Codex Ten",
    "Commentary",
    "https://www.astralcodexten.com/feed",
    "#1e3a5f",
    "Scott Alexander on medicine, prediction and everything else.",
    "post",
  ),
  entry(
    "marginal-revolution",
    "Marginal Revolution",
    "Commentary",
    "https://marginalrevolution.com/feed",
    "#1c3f94",
    "Tyler Cowen and Alex Tabarrok on economics and culture.",
    "post",
  ),
  entry(
    "interfluidity",
    "Interfluidity",
    "Commentary",
    "https://drafts.interfluidity.com/feed/index.rss",
    "#5b536d",
    "Steve Randy Waldman on money, inequality, democracy and institutions.",
    "post",
  ),
  entry(
    "the-diff",
    "The Diff",
    "Commentary",
    "https://www.thediff.co/archive/rss/",
    "#2f5c57",
    "Byrne Hobart on finance, technology and business strategy; some subscriber articles.",
    "post",
  ),
  entry(
    "scholars-stage",
    "The Scholar's Stage",
    "Commentary",
    "https://scholars-stage.org/feed/",
    "#604529",
    "Tanner Greer on China, grand strategy, history and political institutions.",
    "post",
  ),
  entry(
    "chartbook",
    "Chartbook",
    "Commentary",
    "https://adamtooze.substack.com/feed",
    "#2f5984",
    "Adam Tooze on economics, geopolitics and history; some subscriber articles.",
    "post",
  ),
  entry(
    "overcoming-bias",
    "Overcoming Bias",
    "Commentary",
    "https://www.overcomingbias.com/feed",
    "#33526e",
    "Robin Hanson on incentives, hidden motives, institutions and possible futures.",
    "post",
  ),
  entry(
    "bits-about-money",
    "Bits about Money",
    "Commentary",
    "https://www.bitsaboutmoney.com/archive/rss/",
    "#026e55",
    "Patrick McKenzie on payments, banks, fraud and financial infrastructure.",
    "post",
  ),
  entry(
    "net-interest",
    "Net Interest",
    "Commentary",
    "https://www.netinterest.co/feed",
    "#204c64",
    "Marc Rubinstein on financial institutions and markets; some subscriber articles.",
    "post",
  ),
  entry(
    "pursuit-of-happiness",
    "The Pursuit of Happiness",
    "Commentary",
    "https://scottsumner.substack.com/feed",
    "#7e5361",
    "Scott Sumner on monetary economics, public policy and culture.",
    "post",
  ),
  entry(
    "acoup",
    "Unmitigated Pedantry",
    "Commentary",
    "https://acoup.blog/feed/",
    "#7b3f00",
    "Bret Devereaux on ancient history and how war worked.",
    "post",
  ),
  entry(
    "pragmatic-engineer",
    "The Pragmatic Engineer",
    "Commentary",
    "https://newsletter.pragmaticengineer.com/feed",
    "#0f766e",
    "Gergely Orosz on engineering teams and the industry.",
    "post",
  ),
  entry(
    "bbc-news",
    "BBC News",
    "World news",
    "https://feeds.bbci.co.uk/news/rss.xml",
    "#bb1919",
    "Top stories from BBC News.",
    "story",
  ),
  entry(
    "nyt",
    "The New York Times",
    "World news",
    "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml",
    "#121212",
    "The New York Times home page.",
    "story",
  ),
  entry(
    "npr",
    "NPR News",
    "World news",
    "https://feeds.npr.org/1001/rss.xml",
    "#237bbd",
    "Top news stories from NPR.",
    "story",
  ),
  entry(
    "guardian-world",
    "The Guardian: World",
    "World news",
    "https://www.theguardian.com/world/rss",
    "#052962",
    "World news from The Guardian.",
    "story",
  ),
  entry(
    "economist",
    "The Economist",
    "World news",
    "https://www.economist.com/latest/rss.xml",
    "#e3120b",
    "The latest from The Economist.",
  ),
  entry(
    "al-jazeera",
    "Al Jazeera",
    "World news",
    "https://www.aljazeera.com/xml/rss/all.xml",
    "#fa9000",
    "News from Al Jazeera, with a wide view of the world.",
    "story",
  ),
  entry(
    "ft-technology",
    "FT Technology",
    "World news",
    "https://www.ft.com/technology?format=rss",
    "#0d7680",
    "Financial Times technology coverage; subscriber articles.",
    "story",
  ),
  entry(
    "nasa",
    "NASA",
    "Science",
    "https://www.nasa.gov/feed/",
    "#0b3d91",
    "Missions, images and discoveries from NASA.",
    "story",
  ),
  entry(
    "quanta",
    "Quanta Magazine",
    "Science",
    "https://www.quantamagazine.org/feed/",
    "#c4302b",
    "Mathematics, physics, biology and computer science explained.",
  ),
  entry(
    "nautilus",
    "Nautilus",
    "Science",
    "https://nautil.us/feed/",
    "#1f5f6b",
    "Stories connecting science, evolution, psychology and philosophy.",
  ),
  entry(
    "knowable",
    "Knowable Magazine",
    "Science",
    "https://knowablemagazine.org/rss",
    "#2965a8",
    "Scientific research explained with context, from Annual Reviews.",
  ),
  entry(
    "experimental-history",
    "Experimental History",
    "Science",
    "https://www.experimental-history.com/feed",
    "#b07818",
    "Adam Mastroianni on psychology, experiments and how science works.",
    "post",
  ),
  entry(
    "works-in-progress",
    "Works in Progress",
    "Science",
    "https://worksinprogress.co/rss.xml",
    "#2c4a3e",
    "Scientific discoveries, infrastructure, industrial history and economic progress.",
  ),
  entry(
    "nature",
    "Nature",
    "Science",
    "https://www.nature.com/nature.rss",
    "#c00c00",
    "News and research papers from the journal Nature.",
  ),
  entry(
    "science-daily",
    "ScienceDaily",
    "Science",
    "https://www.sciencedaily.com/rss/top/science.xml",
    "#004a7c",
    "Research summaries across the sciences, linked to source.",
    "story",
  ),
  entry(
    "claude-code-releases",
    "Claude Code releases",
    "Releases",
    "https://github.com/anthropics/claude-code/releases.atom",
    "#24292f",
    "Each Claude Code release, with its notes.",
    "release",
    "github",
  ),
  entry(
    "typescript-releases",
    "TypeScript releases",
    "Releases",
    "https://github.com/microsoft/TypeScript/releases.atom",
    "#3178c6",
    "Each TypeScript release, with its notes.",
    "release",
    "github",
  ),
  entry(
    "ollama-releases",
    "Ollama releases",
    "Releases",
    "https://github.com/ollama/ollama/releases.atom",
    "#24292f",
    "Each Ollama release, with its notes.",
    "release",
    "github",
  ),
  entry(
    "github-changelog",
    "GitHub Changelog",
    "Releases",
    "https://github.blog/changelog/feed/",
    "#24292f",
    "What changed on GitHub this week.",
    "post",
    "github",
  ),
  entry(
    "pypi-updates",
    "PyPI updates",
    "Releases",
    "https://pypi.org/rss/updates.xml",
    "#3775a9",
    "Packages released to the Python Package Index.",
    "release",
  ),
  entry(
    "anthropic-status",
    "Claude Status",
    "Status",
    "https://status.claude.com/history.atom",
    "#d97757",
    "Claude incidents as they are filed and resolved.",
    "incident",
  ),
  entry(
    "github-status",
    "GitHub Status",
    "Status",
    "https://www.githubstatus.com/history.atom",
    "#24292f",
    "GitHub incidents as they are filed and resolved.",
    "incident",
    "github",
  ),
  entry(
    "openai-status",
    "OpenAI Status",
    "Status",
    "https://status.openai.com/history.atom",
    "#10a37f",
    "OpenAI incidents as they are filed and resolved.",
    "incident",
  ),
  entry(
    "cisa-advisories",
    "CISA Advisories",
    "Security",
    "https://www.cisa.gov/cybersecurity-advisories/all.xml",
    "#005288",
    "Advisories and alerts from the US cyber defence agency.",
    "advisory",
  ),
  entry(
    "krebs-on-security",
    "Krebs on Security",
    "Security",
    "https://krebsonsecurity.com/feed/",
    "#c8102e",
    "Brian Krebs on breaches, fraud and the people behind them.",
    "post",
  ),
  entry(
    "youtube-fireship",
    "Fireship",
    "Video",
    "https://www.youtube.com/feeds/videos.xml?channel_id=UCsBjURrPoezykLs9EqgamOA",
    "#ff0000",
    "Short, fast explainers on web and cloud development.",
    "video",
    "youtube",
  ),
  entry(
    "youtube-3blue1brown",
    "3Blue1Brown",
    "Video",
    "https://www.youtube.com/feeds/videos.xml?channel_id=UCYO_jab_esuFRV4b17AJtAw",
    "#ff0000",
    "Grant Sanderson's visual mathematics, one topic at a time.",
    "video",
    "youtube",
  ),
  entry(
    "youtube-computerphile",
    "Computerphile",
    "Video",
    "https://www.youtube.com/feeds/videos.xml?channel_id=UC9-y-6csu5WGm29I7JiwpnA",
    "#ff0000",
    "Computer science explained by the people who teach it.",
    "video",
    "youtube",
  ),
  entry(
    "mastodon",
    "Mastodon",
    "Social networks",
    "https://mastodon.social/@Mastodon.rss",
    "#6364ff",
    "Posts from the official Mastodon account.",
    "post",
  ),
  entry(
    "bluesky",
    "Bluesky",
    "Social networks",
    "https://bsky.app/profile/bsky.app/rss",
    "#1185fe",
    "Posts from the official Bluesky account.",
    "post",
  ),
  entry(
    "xkcd",
    "xkcd",
    "Fun",
    "https://xkcd.com/atom.xml",
    "#96a8c8",
    "A webcomic of romance, sarcasm, math and language.",
    "comic",
  ),
];

export const feedById = new Map(feedCatalog.map((feed) => [feed.id, feed]));

/**
 * A watch's terms: words, and "a quoted phrase" as one term. A story matches
 * when every term appears. Shared so the add form can preview a watch against
 * what is already on the page before it is created.
 */
export function watchTerms(query: string) {
  const terms: string[] = [];
  for (const match of query.matchAll(/"([^"]+)"|(\S+)/g)) {
    const term = (match[1] ?? match[2]).trim().toLowerCase();
    if (term) terms.push(term);
    if (terms.length >= 6) break;
  }
  return terms;
}

const edge = "[^\\p{L}\\p{N}]";
/**
 * Whether a story matches a watch. Terms match whole words, so "ai" finds
 * "AI safety" and not "said" — the single most common way a keyword alert
 * becomes useless.
 */
export function matchesWatch(
  terms: string[],
  story: { title: string; summary?: string | null },
) {
  if (!terms.length) return false;
  const text = `${story.title} ${story.summary ?? ""}`
    .toLowerCase()
    .replace(/\s+/g, " ");
  return terms.every((term) =>
    new RegExp(`(^|${edge})${escapeTerm(term)}($|${edge})`, "u").test(text),
  );
}

const escapeTerm = (term: string) =>
  term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
