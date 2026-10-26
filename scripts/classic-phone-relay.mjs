import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, rpc, StrKey, xdr } from "@stellar/stellar-sdk";
import { DEMO_FEE, openCheque } from "../protocol/cheque.mjs";
import { unframe } from "../protocol/frame.mjs";
import { submitTestnetCheque, TESTNET_RPC, TESTNET_VAULT } from "./witness-upload.mjs";

function reply(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function relayPage(participants) {
  const publicPhones = JSON.stringify(participants.map(({ address, label }, index) => ({ address, label: label || `Teléfono ${index + 1}` }))).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sozu Testnet · Subir cheque</title><style>
body{font-family:system-ui,sans-serif;margin:0;background:#101714;color:#edf4ef;padding:24px}main{max-width:560px;margin:28px auto}h1{font-size:30px}p{line-height:1.55;color:#bccbc2}label{display:block;margin:22px 0 8px}select,textarea,button{box-sizing:border-box;width:100%;font:inherit;border-radius:12px;padding:14px;border:1px solid #62756a;background:#19251e;color:#edf4ef}textarea{min-height:150px;font-family:monospace;overflow-wrap:anywhere}button{margin-top:18px;background:#d6efdf;color:#102117;font-weight:700;cursor:pointer}button:disabled{opacity:.5}#result{white-space:pre-wrap;margin:24px 0;line-height:1.5}a{color:#b5e8cb}small{display:block;margin-top:30px;color:#a6b7ad}
</style><main><p>SOZU · TESTNET</p><h1>Subir un cheque recibido</h1><p>Elige el teléfono conectado a internet y pega el mensaje completo que empieza por SOZU1:.</p>
<form id="upload"><label for="settler">Teléfono que sube y recibe la comisión</label><select id="settler" required><option value="">Elige tu teléfono</option></select>
<label for="frame">Cheque SOZU1:</label><textarea id="frame" placeholder="SOZU1:…" maxlength="1000" required spellcheck="false" autocapitalize="off"></textarea><button id="send">Liquidar en testnet</button></form>
<div id="result" role="status"></div><a id="explorer" hidden target="_blank" rel="noopener noreferrer">Ver transacción en Stellar Expert</a><small>Esta página envía transacciones reales de testnet. Funciona mientras el computador del relé está encendido. Solo admite las dos cuentas registradas para esta prueba.</small></main>
<script>
const phones=${publicPhones};const select=document.querySelector('#settler');for(const phone of phones){const option=document.createElement('option');option.value=phone.address;option.textContent=phone.label+' · '+phone.address.slice(0,5)+'…'+phone.address.slice(-5);select.append(option)}
document.querySelector('#upload').addEventListener('submit',async(event)=>{event.preventDefault();const button=document.querySelector('#send');const result=document.querySelector('#result');const link=document.querySelector('#explorer');button.disabled=true;link.hidden=true;result.textContent='Esperando confirmación en Stellar Testnet…';try{const response=await fetch('/api/offline/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({frame:document.querySelector('#frame').value.trim(),settler:select.value})});const data=await response.json();if(data.ok){result.textContent='Liquidado en testnet. Comisión: 0,01 USDC para el teléfono que subió.'}else if(data.reason==='note-used'){result.textContent='note already used — esta nota ya fue liquidada. Segunda comisión: 0 USDC.'}else{result.textContent='No liquidado: '+(data.reason||data.error||'respuesta desconocida')}if(/^[a-f0-9]{64}$/.test(data.hash||'')){link.href='https://stellar.expert/explorer/testnet/tx/'+data.hash;link.hidden=false}}catch{result.textContent='No se pudo contactar con el relé. Puedes volver a intentar el mismo cheque.'}finally{button.disabled=false}});
</script></html>`;
}

async function readBody(request) {
  let size = 0;
  let chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= 4096) chunks.push(chunk);
    else chunks = [];
  }
  if (size > 4096) return null;
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { return null; }
}

export function createClassicRelayServer({ participants, submit, append = () => {}, priorRows = [], now = () => Math.floor(Date.now() / 1000) }) {
  const accounts = new Map(participants.map((entry) => [entry.address, entry]));
  const rows = [...priorRows];
  const cache = new Map(rows.map((row) => [row.wireHash, row]));
  const inflight = new Map();
  let tail = Promise.resolve();

  function outcome(row) {
    return { status: row.ok ? 200 : 422, body: {
      network: "testnet", ok: row.ok, hash: row.hash, reason: row.reason,
      fee: row.fee, settler: row.settler, explorerUrl: row.explorerUrl,
    } };
  }

  async function settle(body) {
    const settler = typeof body?.settler === "string" ? body.settler.trim().toUpperCase() : "";
    if (!accounts.has(settler)) return { status: 403, body: { error: "settler-not-enrolled" } };
    const wire = unframe(body?.frame, "SOZU1:");
    const cheque = openCheque(wire);
    if (!cheque.ok) return { status: 400, body: { error: cheque.reason } };
    const owner = StrKey.encodeEd25519PublicKey(cheque.owner);
    const payee = StrKey.encodeEd25519PublicKey(cheque.payee);
    const participant = accounts.get(owner);
    if (!participant || !accounts.has(payee)) return { status: 403, body: { error: "account-not-enrolled" } };
    if (cheque.network !== 1 || !cheque.vault.equals(Buffer.alloc(32, 1))) return { status: 422, body: { error: "wrong-vault-or-network" } };
    if (cheque.deviceKey.toString("hex") !== participant.deviceKey) return { status: 403, body: { error: "device-key" } };
    const wireHash = createHash("sha256").update(wire).digest("hex");
    if (cache.has(wireHash)) return outcome(cache.get(wireHash));
    if (inflight.has(wireHash)) return inflight.get(wireHash);
    if (cheque.expiry <= BigInt(now()) || cheque.expiry > BigInt(participant.lockedUntil)) return { status: 422, body: { error: "expired-or-unlocked" } };
    if (cheque.fee !== DEMO_FEE || cheque.amount + cheque.fee > BigInt(participant.collateral)) return { status: 422, body: { error: "fee-or-collateral" } };
    if (inflight.size >= 20) return { status: 503, body: { error: "relay-busy" } };
    const work = tail.then(async () => {
      const result = await submit({ wire, settler });
      if (!/^[a-f0-9]{64}$/.test(result.txHash ?? "") || typeof result.ok !== "boolean"
          || BigInt(result.fee) !== (result.ok ? DEMO_FEE : 0n)) throw new Error("unconfirmed-result");
      const row = {
        at: new Date(now() * 1000).toISOString(), type: result.ok ? "settle" : result.reason === "note-used" ? "duplicate" : "rejected",
        wireHash, noteId: cheque.noteId.toString("hex"), owner, payee, settler, source: settler,
        ok: result.ok, reason: result.reason ?? null, fee: result.fee.toString(), hash: result.txHash,
        explorerUrl: `https://stellar.expert/explorer/testnet/tx/${result.txHash}`,
      };
      rows.push(row);
      cache.set(wireHash, row);
      append(row);
      return outcome(row);
    });
    tail = work.catch(() => {});
    inflight.set(wireHash, work);
    try { return await work; }
    finally { inflight.delete(wireHash); }
  }

  return createServer({ requestTimeout: 20_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, async (request, response) => {
    let path;
    try { path = new URL(request.url, "http://localhost").pathname; }
    catch { return reply(response, 400, { error: "invalid-request-path" }); }
    if (request.method === "GET" && path === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
      return response.end(relayPage(participants));
    }
    if (request.method === "GET" && path === "/health") return reply(response, 200, { network: "testnet", ready: true });
    if (request.method === "GET" && path === "/api/offline/ledger") return reply(response, 200, { network: "testnet", count: rows.length, rows });
    if (request.method !== "POST" || path !== "/api/offline/submit") return reply(response, 404, { error: "not-found" });
    try {
      const body = await readBody(request);
      if (!body || typeof body.frame !== "string") return reply(response, 400, { error: "frame-required" });
      const result = await settle(body);
      reply(response, result.status, result.body);
    } catch {
      reply(response, 503, { error: "settlement-unavailable" });
    }
  });
}

async function main() {
  const sessions = process.env.SOZU_RELAY_SESSIONS?.split(";").filter(Boolean) ?? [];
  if (sessions.length !== 2) throw new Error("Set SOZU_RELAY_SESSIONS to the two newly provisioned phone session directories");
  const signers = new Map();
  const labels = process.env.SOZU_RELAY_LABELS?.split(";") ?? [];
  const participants = sessions.map((directory, index) => {
    const receipt = JSON.parse(readFileSync(join(directory, "owner-receipt.json"), "utf8"));
    const claim = JSON.parse(readFileSync(join(directory, "wallet-claim.private.json"), "utf8"));
    if (!claim.wallet?.generated || receipt.network !== "testnet" || receipt.contractId !== TESTNET_VAULT
        || receipt.protocolVaultId !== "01".repeat(32) || receipt.lockedUntil <= Date.now() / 1000) throw new Error("Invalid phone enrollment");
    let signer;
    try { signer = Keypair.fromSecret(claim.wallet.secret); }
    catch { throw new Error("Invalid local phone signing account"); }
    if (signer.publicKey() !== receipt.owner) throw new Error("Phone owner does not match the local wallet");
    signers.set(receipt.owner, signer);
    return { address: receipt.owner, label: labels[index], deviceKey: receipt.deviceKey, lockedUntil: receipt.lockedUntil, collateral: receipt.collateral };
  });
  if (signers.size !== 2) throw new Error("Two distinct phone accounts are required");
  const rpcServer = new rpc.Server(TESTNET_RPC);
  await Promise.all(participants.map(async (participant) => {
    const key = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Account"), xdr.ScVal.scvBytes(StrKey.decodeEd25519PublicKey(participant.address))]);
    const entry = await rpcServer.getContractData(TESTNET_VAULT, key);
    const value = JSON.parse(JSON.stringify(entry)).val.contract_data.val.map;
    if (value.find((row) => row.key.symbol === "device_key").val.bytes !== participant.deviceKey
        || String(value.find((row) => row.key.symbol === "locked_until").val.u64) !== String(participant.lockedUntil)) throw new Error("Phone deposit is not registered for this device");
  }));
  const logPath = process.env.SOZU_RELAY_LOG;
  if (!logPath) throw new Error("Set SOZU_RELAY_LOG to a local ledger path outside Git");
  mkdirSync(dirname(logPath), { recursive: true });
  const priorRows = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const server = createClassicRelayServer({
    participants, priorRows,
    submit: ({ wire, settler }) => submitTestnetCheque({ wire, signer: signers.get(settler) }),
    append: (row) => appendFileSync(logPath, `${JSON.stringify(row)}\n`, { mode: 0o600 }),
  });
  server.listen(Number(process.env.PORT ?? "3033"), "127.0.0.1", () => console.log("Classic phone relay ready on loopback; keys remain local"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("Classic phone relay failed to initialize; check local enrollment and RPC access"); process.exitCode = 1; });
}
