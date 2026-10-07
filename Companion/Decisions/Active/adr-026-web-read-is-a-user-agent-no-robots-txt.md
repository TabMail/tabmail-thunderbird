## ADR-026: `web_read` Reads a Page as a User Agent, Without Asking robots.txt

**Context:** `web_read` fetched the site's `/robots.txt` before every page and refused a path it
disallowed. The parser matched a group only when its `User-agent` was `*` or the exact full
user-agent string, not the product token RFC 9309 §2.2.1 matches (TabMail Voice issue #45), and a
later group naming another crawler cleared the rules already gathered from `*`, so a common file
(`*` first, other crawlers after) lost its general rules. Owner, 2026-10-07: rather than fix the
parser, drop the check. robots.txt is written for crawlers, automatic clients that walk a site;
`web_read` fetches one page because the user asked, as a browser does, and browsers do not consult
robots.txt.

**Decision:** `web_read` no longer fetches or parses robots.txt (`isPathAllowedByRobots`,
`checkRobotsTxt` and the unused `CONFIG.USER_AGENT` deleted; `test/webReadRobots.test.js` removed).
It fetches the page alone. The iOS app's `WebReadTool` and TabMail Voice's `web_read` drop the check
in the same change, so the three clients stay alike, and the backend's `web_read` tool description
no longer says the tool respects robots.txt.

**Rationale:** What keeps the tool a good citizen is unchanged: `tmWebFetch` names TabMail in the
User-Agent (`TabMail/1.0 (Thunderbird Extension; +https://tabmail.app)`), so a site can see who is
asking and block it; the backend lets the model pass only a URL the user gave or one from an earlier
tool result, never a private address; and each call reads one page, following no links. A broken
parser kept in step across three clients bought little, and its fetch delayed every read by up to
5 s.

**Consequences:**
- A page a site's robots.txt disallows for crawlers is read when the user asks for it.
- One request per read instead of two; no robots.txt timeout before the page.
- Voice issue #45 (product-token matching) is closed as superseded.
