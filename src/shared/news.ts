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
};

/** A story in Social, with the catalog feed it came from. */
export type SocialStory = NewsStory & { feed: string };

export type SocialResponse = {
  stories: SocialStory[];
  /** The feeds you added that couldn't be loaded and had no earlier copy. */
  failed: string[];
};

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
};

const entry = (
  id: string,
  name: string,
  category: string,
  url: string,
  color: string,
  description: string,
  kind = "article",
): FeedEntry => ({
  id,
  name,
  category,
  description,
  home: new URL(url).hostname.replace(/^(www|feeds|rss|blog|export)\./, ""),
  url,
  color,
  kind,
});
const reddit = (name: string, description: string) =>
  entry(
    `reddit-${name.toLowerCase()}`,
    `r/${name}`,
    "Reddit",
    `https://www.reddit.com/r/${name}/hot/.rss?limit=50`,
    "#ff4500",
    description,
    "post",
  );

// Social only fetches these checked-in public feeds, never an address someone
// types, so the server can't be pointed at another host. Each was read with
// the shared parser before it was listed; changing one is a source change.
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
    "product-hunt",
    "Product Hunt",
    "Tech news",
    "https://www.producthunt.com/feed",
    "#da552f",
    "New products launching today.",
    "launch",
  ),
  reddit("programming", "Hot posts about programming."),
  reddit("technology", "Hot posts about technology news."),
  reddit("MachineLearning", "Research papers, projects and discussion."),
  reddit("LocalLLaMA", "Running and building with open models."),
  reddit("science", "New research, linked to its source."),
  reddit("worldnews", "Major news from outside the US."),
  entry(
    "openai-news",
    "OpenAI News",
    "AI",
    "https://openai.com/news/rss.xml",
    "#10a37f",
    "Announcements and research from OpenAI.",
  ),
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
    "nature",
    "Nature",
    "Science",
    "https://www.nature.com/nature.rss",
    "#c00c00",
    "News and research papers from the journal Nature.",
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
