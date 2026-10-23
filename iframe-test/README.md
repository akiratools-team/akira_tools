# External iframe acceptance host

An isolated buildless HTML/CSS/JS page. It does not run the repository's archive
tools, Next.js application, package installation or postinstall scripts.

## Selected hosting: Cloudflare Pages Direct Upload

The owner selected free static Cloudflare Pages after the Vercel team was
confirmed as Hobby. No Vercel project, deployment, trial or paid plan was created.

- Separate Pages project: `3dviewer-iframe-test` if available.
- Upload exactly `index.html`, `styles.css`, `app.js`, `viewer-config.mjs`, `_headers`
  at the archive root. Exclude source tests, README and Vercel configuration.
- No build, Functions, environment variables, database or R2 binding.
- `_headers` applies the same CSP/noindex/nosniff/referrer policy on Pages.
- Repository source stays on `codex/iframe-acceptance-host`; Direct Upload does
  not automatically build or sync that branch. Deployments must be explicitly
  uploaded again after a source change. Keep a source SHA/archive hash record.
- Pages Direct Upload cannot be converted into Git integration for the same
  project; a new project would be needed if automatic builds are wanted later.
- This is a newly authorized public sample-only external test website, not a
  retry of the previously blocked local file page.

## Original Vercel proposal (not deployed)

- Repository: `akiratools-team/akira_tools`.
- Branch: `codex/iframe-acceptance-host` (keep `master` unchanged).
- Separate project name: `3dviewer-iframe-test` if available.
- Root Directory: `iframe-test`.
- Framework: Other; install/build commands empty; output directory `.`.
- No environment variables, database, storage or credentials.
- Use only public sample shares. Review hosting-plan eligibility before deployment;
  Vercel Hobby is personal/non-commercial, not automatically valid for product QA.
- This is a newly authorized external test website. It is not a retry of the
  previously blocked local file page, which is not opened or proxied here.

Load only one frame at a time. The fixed Preview origin and model path syntax
are validated, credentials/other hosts are rejected and query parameters are
rebuilt. No iframe sandbox is added, so this exercises ordinary generated embed
markup rather than an artificial sandbox policy. Cross-origin content is never
read or treated as an automatic pass. CSP permits only the intended frame host.

## Cases and limits

The default link is a previously shared public sample owned by Pro. The custom
appearance request asks for dark/hidden controls/visible branding; the server
still decides entitlement. Paste a public share owned by Free to test actual
Free behavior. The bundled demo is a layout/default-branding control only.

The narrow frame is not a real phone. The fullscreen button requests fullscreen
from the parent page, not from the viewer's own UI. The viewer currently has no
dedicated embed fullscreen button. A navigation/load event is not a rendered
model assertion. Check unauthenticated application access independently of
Vercel Preview protection; record protection blockers without disabling security.

Results are self-reported and export only to a local JSON file. No analytics,
cookies, localStorage or cloud result writes are used. A new load resets all
observations. Unloading blocks report export until another case is loaded.

## Local logic checks

`node --test tests/viewer-config.test.mjs` checks URL isolation, query handling,
demo defaults and untested result normalization. `node --check app.js` checks
syntax. These do not establish actual browser/frame/fullscreen acceptance.
No localhost/file parent or alternate browser is used for cross-site acceptance.
# Free-owner cloud-share guard

For an actual Free-owner share, choose **Free-owner · request hidden branding**
and enter its public UUID URL on the fixed Preview origin. The host requests
dark theme, hidden controls and hidden branding. The viewer must apply the
owner's server-side entitlement and retain Free defaults. A real Free plan
must be independently verified; selecting this case does not establish it.
No private model IDs, model bytes or account details are added to source.

