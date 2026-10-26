import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { issueCheque } from "../protocol/cheque.mjs";
import { generateIdentity } from "../protocol/p256.mjs";
import { createClassicRelayServer } from "../scripts/classic-phone-relay.mjs";

function fixture() {
  const owner = Keypair.random().publicKey();
  const merchant = Keypair.random().publicKey();
  const identity = generateIdentity();
  const merchantIdentity = generateIdentity();
  const fields = {
    network: 1, vault: Buffer.alloc(32, 1), noteId: Buffer.alloc(16, 7),
    amount: 10_000n, fee: 100_000n, cap: 110_000n, expiry: 1_800_000_100n,
    owner: StrKey.decodeEd25519PublicKey(owner), payee: StrKey.decodeEd25519PublicKey(merchant),
  };
  return {
    owner, merchant, identity, fields,
    frame: issueCheque(fields, identity.privateKey, identity.compressed).frame,
    participants: [
      { address: owner, deviceKey: identity.compressed.toString("hex"), lockedUntil: 1_800_000_200, collateral: "100000000" },
      { address: merchant, deviceKey: merchantIdentity.compressed.toString("hex"), lockedUntil: 1_800_000_200, collateral: "100000000" },
    ],
  };
}

async function relay(t, options) {
  const server = createClassicRelayServer({ now: () => 1_800_000_000, ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    post: (body) => fetch(`${base}/api/offline/submit`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }),
    ledger: () => fetch(`${base}/api/offline/ledger`).then((response) => response.json()),
  };
}

test("phone upload settles its signed cheque as the requested registered G settler and exposes the real hash", async (t) => {
  const f = fixture();
  const api = await relay(t, { participants: f.participants, submit: async ({ wire, settler }) => {
    assert.equal(wire.length, 243);
    assert.equal(settler, f.merchant);
    return { ok: true, fee: 100_000n, reason: null, txHash: "1".repeat(64) };
  } });
  const response = await api.post({ frame: f.frame, settler: f.merchant });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(result.hash, "1".repeat(64));
  assert.equal(result.fee, "100000");
  assert.equal(result.settler, f.merchant);
  const ledger = await api.ledger();
  assert.equal(ledger.count, 1);
  assert.equal(ledger.rows[0].hash, "1".repeat(64));
  assert.equal(JSON.stringify(ledger).includes('"secret"'), false);
});

test("malformed, foreign-owner, wrong-device and expired cheques never reach the chain", async (t) => {
  const f = fixture();
  let submissions = 0;
  const api = await relay(t, { participants: f.participants, submit: async () => { submissions++; throw new Error("must-not-submit"); } });
  const issue = (fields, identity = f.identity) => issueCheque({ ...f.fields, ...fields }, identity.privateKey, identity.compressed).frame;
  const cases = [
    { frame: "SOZU1:bad", settler: f.merchant, status: 400 },
    { frame: f.frame, settler: Keypair.random().publicKey(), status: 403 },
    { frame: issue({ owner: Buffer.alloc(32, 4) }), settler: f.merchant, status: 403 },
    { frame: issue({}, generateIdentity()), settler: f.merchant, status: 403 },
    { frame: issue({ expiry: 1_799_999_999n }), settler: f.merchant, status: 422 },
    { frame: issue({ network: 0 }), settler: f.merchant, status: 422 },
    { frame: issue({ vault: Buffer.alloc(32, 9) }), settler: f.merchant, status: 422 },
    { frame: issue({ fee: 0n }), settler: f.merchant, status: 422 },
  ];
  for (const entry of cases) {
    const response = await api.post({ frame: entry.frame, settler: entry.settler });
    assert.equal(response.status, entry.status);
  }
  assert.equal(submissions, 0);
  assert.equal((await api.ledger()).count, 0);
});

test("concurrent retries of the same wire settle once and retain the first uploader's fee", async (t) => {
  const f = fixture();
  let submissions = 0;
  const api = await relay(t, { participants: f.participants, submit: async () => {
    submissions++;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return { ok: true, fee: 100_000n, reason: null, txHash: "1".repeat(64) };
  } });
  const results = await Promise.all([f.merchant, f.owner, f.merchant].map(async (settler) => (await api.post({ frame: f.frame, settler })).json()));
  assert.equal(submissions, 1);
  assert.equal((await api.ledger()).count, 1);
  for (const result of results) {
    assert.equal(result.hash, "1".repeat(64));
    assert.equal(result.settler, results[0].settler);
  }
});

test("a distinct second cheque for one note exposes note-used without claiming a payment or fee", async (t) => {
  const f = fixture();
  let submissions = 0;
  const api = await relay(t, { participants: f.participants, submit: async () => {
    submissions++;
    return submissions === 1
      ? { ok: true, fee: 100_000n, reason: null, txHash: "1".repeat(64) }
      : { ok: false, fee: 0n, reason: "note-used", txHash: "2".repeat(64) };
  } });
  await api.post({ frame: f.frame, settler: f.merchant });
  const second = issueCheque({ ...f.fields, payee: f.fields.owner }, f.identity.privateKey, f.identity.compressed);
  const response = await api.post({ frame: second.frame, settler: f.owner });
  assert.equal(response.status, 422);
  const result = await response.json();
  assert.equal(result.ok, false);
  assert.equal(result.reason, "note-used");
  assert.equal(result.fee, "0");
  assert.equal(result.hash, "2".repeat(64));
  const ledger = await api.ledger();
  assert.equal(ledger.count, 2);
  assert.equal(ledger.rows[0].noteId, ledger.rows[1].noteId);
  assert.equal(ledger.rows[1].type, "duplicate");
});

test("a confirmed identical-wire retry keeps its original result after cheque expiry", async (t) => {
  const f = fixture();
  let clock = 1_800_000_000;
  let submissions = 0;
  const api = await relay(t, { participants: f.participants, now: () => clock, submit: async () => {
    submissions++;
    return { ok: true, fee: 100_000n, reason: null, txHash: "1".repeat(64) };
  } });
  const first = await (await api.post({ frame: f.frame, settler: f.merchant })).json();
  clock = 1_800_000_300;
  const retry = await api.post({ frame: f.frame, settler: f.owner });
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), first);
  assert.equal(submissions, 1);
});

test("a malformed request path returns 400 and leaves the relay healthy", async (t) => {
  const f = fixture();
  const api = await relay(t, { participants: f.participants, submit: async () => { throw new Error("must-not-submit"); } });
  const response = await fetch(`${api.base}//[`, { signal: AbortSignal.timeout(1000) });
  assert.equal(response.status, 400);
  assert.equal((await fetch(`${api.base}/health`)).status, 200);
});
