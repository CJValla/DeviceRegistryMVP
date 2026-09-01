# Device Compliance Registry

An interactive prototype of AI-assisted, human-in-the-loop device registration triage for the National Device Assurance Agency, an illustrative regulator that registers grid-connected consumer energy devices before they enter the market. A model assists the assessment; a person retains authority over every consequential decision.

This is a demonstration prototype, not a production system or a live agency service. The agency, manufacturers, and device data are illustrative.

## Contents

| Path | Purpose |
|---|---|
| `index.html` | The prototype application: submission form, assessor queue, and assurance dashboard. |
| `ndaa-triage-worker/` | A Cloudflare Worker that performs triage and the routing decision server-side. |
| `Device_Compliance_Registry_Overview.docx` | A third-party overview of how the application works. |

## How it works

A manufacturer submits a device model for registration. On submission, the application flows through four stages:

1. **Triage.** The application is assessed for risk, producing a risk score and band, a confidence value, a recommendation, plain-language reasoning, and a set of flags that each name the field they are based on.
2. **Routing.** A set of deterministic rules decides routing. An application is auto-approved only when the recommendation is Auto-Approve, confidence is at or above 0.75, the risk band is Low, and there are no critical flags. Anything else is routed to a human.
3. **Human review.** An assessor reviews each routed case with the recommendation, reasoning, and the routing rules visible, then approves, rejects, or returns it for more information. The person decides; the model only recommends.
4. **Audit.** Every step is written to an append-only audit trail, attributing each action to a system process, a named model, or a named human, with a timestamp.

## Two ways to run the triage

**Local engine (default).** With no endpoint configured, the prototype runs a deterministic, rule-based triage engine inside the page. It needs no key, works offline, and is fully self-contained. This is the default for demonstration and offline use.

**Server-side triage (recommended for anything hosted).** When `TRIAGE_ENDPOINT` in `index.html` is set to a deployed Worker URL, the prototype submits each application to the Worker, which performs the triage and the routing decision and returns a result the browser renders. See "Where the decision is made" below.

## Where the decision is made

For anything beyond a local demonstration, triage and the routing decision are performed by the Worker, not in the browser and not by the model. The reasons:

- **Integrity of the decision.** Routing logic in the browser can be inspected and altered by anyone who opens the page. Performed on the server, the outcome comes from a controlled component the applicant cannot reach.
- **The model does not decide.** The Worker applies the deterministic routing rules to the model's outputs. The model contributes the reasoning; the rules produce the routing outcome.
- **Protection of credentials and reference data.** Any model credential and the manufacturer history that feeds the rules are held on the server, never exposed to the client.

Under this design the browser is a presentation layer: it collects the application, displays the returned assessment, and provides the assessor's review workspace.

## Running locally

Open `index.html` in a browser. Go to **Register a device** and use **Load 5 sample applications** to see the full range of outcomes: two auto-approve and three route to a human, each for a clear reason (an expired or near-expiry certificate, an unsigned safety attestation, and a novel device from a first-time manufacturer with lower confidence).

## Deploying the Worker

The Worker uses Cloudflare Workers AI. The model runs on Cloudflare, so there is no external key to manage.

1. Install and sign in:

       npm install -g wrangler
       wrangler login

2. Deploy from the `ndaa-triage-worker` folder:

       wrangler deploy

   Wrangler prints a URL such as `https://ndaa-triage.<subdomain>.workers.dev`.

3. Connect the prototype. Set `TRIAGE_ENDPOINT` in `index.html` to that URL:

       const TRIAGE_ENDPOINT = "https://ndaa-triage.<subdomain>.workers.dev";

4. Restrict access. In `ndaa-triage-worker/wrangler.toml`, set `ALLOWED_ORIGIN` to the prototype's origin and deploy again:

       [vars]
       ALLOWED_ORIGIN = "https://<your-prototype-host>"

If the Worker is ever unreachable, the prototype falls back to the local engine so a submission is never blocked.

## Testing the Worker directly

    curl -X POST https://ndaa-triage.<subdomain>.workers.dev \
      -H "content-type: application/json" \
      -d '{
        "ref":"REG-2026-004182","deviceType":"Home Battery Inverter",
        "manuId":"MFR-1001","manuName":"Helion Power Systems","model":"Helion HX-5",
        "power":"5.0","cert":"CERT-88231","certExp":"2027-06-30",
        "testRep":"TR-55120","safety":true,"standards":"AS/NZS 4777.2; IEC 62109"
      }'

The response contains the assessment and the routing decision, including the pass or fail detail of each routing check and a meta block recording the model used, the confidence threshold, and the time of assessment.

## Notes

- **Model pinning.** The Workers AI model is pinned in `ndaa-triage-worker/src/index.js`. Cloudflare retires models over time; if a deploy fails with an unknown-model error, update that value from the current Workers AI model list.
- **Confidence.** The confidence value is derived from the rule findings, not self-reported by the model.
- **Reproducibility.** The routing rules produce the same decision for the same input every time, independently of the model.
