/** Newsletter HTML builder and story verification. Pure: no network, no database. */
import {
  buildNewsletterHtml,
  espMergeTags,
  escapeHtml,
  findInventedReporting,
  lookbackStatus,
  resolveFooterText,
  sanitizeBodyHtml,
  verifyStories,
} from "@/lib/agents/newsletter-html";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name}`, detail ?? "");
  }
}

// --- sanitiser
const dirty = `<p onclick="x()">Hi <script>alert(1)</script><strong>bold</strong> <a href="javascript:evil()">bad</a> <a href="https://ok.com/a?x=1&y=2" onclick="z">ok</a><img src=x onerror=y></p><div>loose</div>`;
const clean = sanitizeBodyHtml(dirty);
check("sanitize: script removed with contents", !/script|alert/i.test(clean), clean);
check("sanitize: onclick and onerror dropped", !/onclick|onerror/i.test(clean), clean);
check("sanitize: javascript: href dropped, text kept", !/javascript:/i.test(clean) && clean.includes("bad"), clean);
check("sanitize: safe link kept with escaped ampersand", clean.includes('href="https://ok.com/a?x=1&amp;y=2"'), clean);
check("sanitize: strong kept, img and div tags removed", clean.includes("<strong>") && !/<img|<div/i.test(clean), clean);
check("sanitize: plain text becomes paragraphs", sanitizeBodyHtml("One\n\nTwo").match(/<p /g)?.length === 2);
check("sanitize: unclosed tags are closed", /<\/p>$/.test(sanitizeBodyHtml("<p>open")));

// --- merge tags
check("tags: Mailchimp", espMergeTags("Mailchimp").unsubscribe === "*|UNSUB|*" && espMergeTags("Mailchimp").address === "*|LIST:ADDRESSLINE|*");
check("tags: Klaviyo", espMergeTags("Klaviyo").unsubscribe === "{% unsubscribe_url %}" && espMergeTags("Klaviyo").address === "{{ organization.full_address }}");
check("footer placeholder replaced", resolveFooterText("Bye [[UNSUBSCRIBE_URL]]", "Klaviyo") === "Bye {% unsubscribe_url %}");

const issue = (espTarget: string) => ({
  newsletterName: 'The <Brief> & "Co"',
  issueNumber: 7,
  previewText: "Preview",
  editorialNote: "Note <script>x</script>\n\nSecond",
  stories: [
    { headline: "Ext <b>", body: "<p>Body</p>", sourceUrl: "https://news.example.com/a", sourceName: "Example News", publishedDate: "2026-10-10" },
    { headline: "Internal", body: "<p>We shipped it</p>", sourceUrl: null, internal: true },
  ],
  cta: { headline: "Talk", body: "Hi", buttonText: "Book", url: "https://x.com/?a=1&b=2" },
  footer: "The Brief. [[UNSUBSCRIBE_URL]]",
  espTarget,
});
const mc = buildNewsletterHtml(issue("Mailchimp"));
const kl = buildNewsletterHtml(issue("Klaviyo"));
check("html: complete document, 600px, table layout", mc.startsWith("<!DOCTYPE html>") && mc.includes('width="600"') && mc.includes("<table") && !mc.includes("<link"));
check("html: name and issue number in header", mc.includes("The &lt;Brief&gt; &amp; &quot;Co&quot;") && mc.includes("Issue 7"));
check("html: model text escaped, script gone", !/<script/i.test(mc) && mc.includes("Ext &lt;b&gt;"), mc);
check("html: Mailchimp unsubscribe and address tags", mc.includes('href="*|UNSUB|*"') && mc.includes("*|LIST:ADDRESSLINE|*") && !mc.includes("[[UNSUBSCRIBE_URL]]"));
check("html: Klaviyo unsubscribe and address tags", kl.includes('href="{% unsubscribe_url %}"') && kl.includes("{{ organization.full_address }}"));
check("html: Read at <sourceName> link, none for internal", mc.includes("Read at Example News") && mc.match(/Read at/g)?.length === 1);
check("html: footer without placeholder still gets unsubscribe", buildNewsletterHtml({ ...issue("Mailchimp"), footer: "Just text" }).includes("*|UNSUB|*"));
check("html: javascript: CTA url is not linked", !buildNewsletterHtml({ ...issue("Mailchimp"), cta: { headline: "T", buttonText: "B", url: "javascript:x" } }).includes("javascript:"));
check("escapeHtml", escapeHtml(`<a href="x">&'`) === "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");

// --- verification
const found = ["https://news.example.com/a", "https://www.other.com/b/"];
const v = verifyStories(
  [
    { headline: "Real", sourceUrl: "https://news.example.com/a" },
    { headline: "Same, loosely", sourceUrl: "http://other.com/b" },
    { headline: "Invented", sourceUrl: "https://made-up.com/story" },
    { headline: "No url", sourceUrl: null },
  ],
  found,
);
check("verify: keeps stories whose URL was returned", v.kept.map((s) => s.headline).join() === "Real,Same, loosely", v.kept);
check("verify: URL replaced by the search result's own string", v.kept[1].sourceUrl === "https://www.other.com/b/", v.kept[1]);
check("verify: a warning per dropped story", v.warnings.length === 2 && v.warnings[0].includes("Invented"), v.warnings);

// --- internal highlights without a URL render and are not subject to verification
const internalOnly = buildNewsletterHtml({ ...issue("Mailchimp"), stories: [{ headline: "Launch", body: "<p>Shipped</p>", sourceUrl: null, internal: true }] });
check("internal highlight without a URL renders, with no source link", internalOnly.includes("Launch") && !internalOnly.includes("Read at") && internalOnly.includes("From us"));

// --- misc
check("invented reporting detected", !!findInventedReporting("Several marketers we spoke with said") && !findInventedReporting("According to Reuters, ad spend rose"));
const now = new Date("2026-10-22T00:00:00Z");
check("lookback: ok / older / unknown", lookbackStatus("2026-10-10", 30, now) === "ok" && lookbackStatus("2026-08-01", 30, now) === "older" && lookbackStatus("soon", 30, now) === "unknown");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
