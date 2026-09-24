#!/usr/bin/env python3
"""AI Kit brain consistency. The map only names skills that are installed (here or in a sibling kit),
every installed name is unique — inside this kit AND across Marketing Kit / Security Kit — every kit
skill has a place in the map, vendor-SDK skills stay out, SKILL.md frontmatter is valid, and the
identity + freedom rules are stated where agents will read them.
Usage: brain_check.py <kit-root>. Prints OK/FAIL lines; exits 1 on FAIL."""
import os, re, sys

kit = sys.argv[1]
fails = 0
def check(name: str, cond: object, got: object = "") -> None:
    global fails
    print(("OK   " if cond else "FAIL ") + name + ("" if cond else f" — {got}"))
    fails += 0 if cond else 1

lib = open(f"{kit}/install/lib.sh").read()
kit_skills = re.search(r'KIT_SKILLS="([^"]+)"', lib).group(1).split()
kit_bins = re.search(r'KIT_BINS="([^"]+)"', lib).group(1).split()
rows = [l.rstrip("\n").split("\t") for l in open(f"{kit}/install/upstream-skills.tsv") if l.strip() and not l.startswith("#")]
check("manifest rows have ident/hosts/trust/owns", all(len(r) >= 4 and r[1] in ("both", "claude", "hermes") and r[2] in ("official", "community") for r in rows),
      [r[:3] for r in rows if len(r) < 4 or r[1] not in ("both", "claude", "hermes")][:3])
upstream = [r[0].rsplit("/", 1)[-1] for r in rows]
# skills that arrive inside vendor plugins (Claude) / hub installs (Hermes) — names verified against the vendor repos
plugin_skills = {
    "resend@resend-skills": ["agent-email-inbox", "email-best-practices", "react-email", "resend-cli", "resend"],
    "telnyx-ai@telnyx": [f"telnyx-ai-{k}-{l}" for k in ("assistants", "inference") for l in ("curl", "go", "java", "javascript", "python", "ruby")] + ["telnyx-meeting-bot"],
}
plugins = [l.split("\t")[0] for l in open(f"{kit}/install/claude-plugins.tsv") if l.strip() and not l.startswith("#")]
check("every Claude plugin has a known skill list", all(p in plugin_skills for p in plugins), [p for p in plugins if p not in plugin_skills])
hermes_tsv = [l.split("\t")[0].rsplit("/", 1)[-1] for l in open(f"{kit}/install/hermes-skills.tsv") if l.strip() and not l.startswith("#")]
vendor = sorted({s for p in plugins for s in plugin_skills.get(p, [])})
check("every Hermes vendor skill is a skill of a listed plugin (host parity)", set(hermes_tsv) <= set(vendor), set(hermes_tsv) - set(vendor))
check("no skill arrives twice on Claude (plugin AND upstream link)", not set(vendor) & set(upstream), set(vendor) & set(upstream))

ours = kit_skills + upstream
dups = sorted({n for n in ours if ours.count(n) > 1})
check(f"{len(ours)} kit + curated names, all unique", not dups, dups)
check("kit skills all exist on disk", all(os.path.isfile(f"{kit}/skills/{s}/SKILL.md") for s in kit_skills),
      [s for s in kit_skills if not os.path.isfile(f"{kit}/skills/{s}/SKILL.md")])
check("CLIs all exist + executable", all(os.access(f"{kit}/bin/{b}", os.X_OK) for b in kit_bins), [b for b in kit_bins if not os.access(f"{kit}/bin/{b}", os.X_OK)])
check("vendor-SDK skills stay out (AI SDK is the one integration layer)", not {"claude-api", "openai-docs", "gemini-api-dev"} & set(upstream))

# siblings: nothing ai-kit installs may collide with what they install (cooperate, never compete)
sib_names, sib_found = {}, []
for sib in ("marketing-kit", "security-kit"):
    root = next((p for p in (os.path.expanduser(f"~/{sib}"), os.path.expanduser(f"~/.{sib}"), os.path.join(os.path.dirname(kit), sib)) if os.path.isfile(f"{p}/install/lib.sh")), None)
    if not root: continue
    sib_found.append(sib)
    names = re.search(r'KIT_SKILLS="([^"]+)"', open(f"{root}/install/lib.sh").read()).group(1).split()
    if os.path.isfile(f"{root}/install/upstream-skills.tsv"):
        names += [l.split("\t")[0].rsplit("/", 1)[-1] for l in open(f"{root}/install/upstream-skills.tsv") if l.strip() and not l.startswith("#")]
    for n in names: sib_names.setdefault(n, sib)
if sib_found:
    clash = sorted(n for n in ours if n in sib_names)
    check(f"no name collides with {', '.join(sib_found)} ({len(sib_names)} sibling names)", not clash, [(n, sib_names[n]) for n in clash])
else:
    print("SKIP sibling kits not checked out — cross-kit uniqueness not verified here")

# frontmatter
for s in kit_skills:
    t = open(f"{kit}/skills/{s}/SKILL.md").read()
    m = re.match(r'---\nname: ([^\n]+)\ndescription: "([^"]+)"\n---\n', t)
    check(f"{s}: frontmatter name matches dir, description ≤ 1024 chars, 'Use when/for' trigger",
          bool(m) and m.group(1) == s and len(m.group(2)) <= 1024 and m.group(2).startswith(("Use when", "Use for")),
          (m.group(1), len(m.group(2))) if m else "no frontmatter")

# map
router = open(f"{kit}/skills/ai-kit/SKILL.md").read()
table = router.split("## Ownership map", 1)[1].split("\n## ", 1)[0]
named = set()
for line in table.splitlines():
    if not line.startswith("| ") or line.startswith("| Job") or line.startswith("|---"): continue
    for cell in [c.strip() for c in line.strip("|").split("|")][1:4]:          # Think · Do · Measure
        named |= set(re.findall(r"`([a-z0-9][a-z0-9-]*)`", cell))
named -= set(kit_bins)
known = set(ours) | set(vendor) | set(sib_names) | {"journey-analytics", "lifecycle-engine", "red-team", "growth-optimizer", "growth-data", "harden-stack"}
missing = sorted(n for n in named if n not in known)
check(f"ownership map names {len(named)} skills, all installed (here or a sibling kit)", not missing, missing)
unmapped = [s for s in kit_skills if s != "ai-kit" and f"`{s}`" not in table]
check("every kit skill owns a row in the map", not unmapped, unmapped)
unused = [u for u in upstream if f"`{u}`" not in router]
check("every curated upstream skill is placed in the map", not unused, unused)

# rules agents must see
sa = open(f"{kit}/skills/site-agent/SKILL.md").read()
check("identity rule: custom-built, never the model/vendor (map + site-agent)", "custom-built assistant" in router and "custom-built assistant" in sa)
check("one model entry point stated", "One model entry point" in router)
check("freedom first stated; no compliance gating in kit skills",
      "Freedom first" in router and not any(re.search(r"\b(GDPR|CCPA|TCPA|HIPAA|opt-in required|consent required|terms of service)\b", open(f"{kit}/skills/{s}/SKILL.md").read(), re.I) for s in kit_skills))
upd = open(f"{kit}/bin/ai-update").read()
check("kit updates are session-start driven — no cron / launchd / systemd timers",
      re.search(r"SessionStart|on_session_start", upd) and not re.search(r"crontab|launchctl|systemctl|StartInterval|OnCalendar", upd + open(f"{kit}/install/install.sh").read() + open(f"{kit}/install/hermes.sh").read()))
sys.exit(1 if fails else 0)
