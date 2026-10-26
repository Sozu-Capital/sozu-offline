// Read-only: fetch existing transactions; never build, sign, or submit one.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Networks, rpc, scValToNative, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { openCheque } from "../protocol/cheque.mjs";

const rpcUrl = "https://soroban-testnet.stellar.org";
const vault = "CDSCQSVWKTYR7EUJK5EQXIFI4L2C4LCPQOIUYP6PMG6KW4O2BZGCRLLV";
const usdc = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const acceptedHash = "579418f7cba7d72bcb5c1d8523ad3d8c40485b4025c825b0609295f42c9c6b28";
const rejectedHash = "7e914fbd6249a7e7ba9ccd5e44ee279337a85340222d34f6d371783c1a41a98d";
const server = new rpc.Server(rpcUrl);
const [instance, ...transactions] = await Promise.all([
  server.getContractData(vault, xdr.ScVal.scvLedgerKeyContractInstance()),
  ...[acceptedHash, rejectedHash].map((hash) => server.getTransaction(hash)),
]);
const instanceData = JSON.parse(JSON.stringify(instance)).val.contract_data.val.contract_instance;
const config = instanceData.storage.find((entry) => entry.key.vec?.[0]?.symbol === "Config").val.map;
const protocolVaultId = config.find((entry) => entry.key.symbol === "vault_id").val.bytes;
assert.equal(config.find((entry) => entry.key.symbol === "token").val.address, usdc);
assert.equal(protocolVaultId, "01".repeat(32), "deployed vault must match the frozen demo ID");

const proof = transactions.map((transaction, index) => {
  assert.equal(transaction.status, "SUCCESS", "RPC must still retain a successful transaction");
  const result = scValToNative(transaction.returnValue);
  const operations = JSON.parse(JSON.stringify(TransactionBuilder.fromXDR(transaction.envelopeXdr, Networks.TESTNET).operations));
  assert.equal(operations.length, 1);
  const invocation = operations[0].func.invoke_contract;
  assert.equal(invocation.contract_address, vault);
  assert.equal(invocation.function_name, "settle");
  const wire = Buffer.from(invocation.args[0].bytes, "hex");
  const cheque = openCheque(wire);
  assert.equal(cheque.ok, true, "the on-chain wire must pass the frozen protocol parser");
  assert.equal(wire.length, 243);
  assert.equal(cheque.vault.toString("hex"), protocolVaultId);
  assert.equal(cheque.noteId.toString("hex"), Buffer.from(result.note_id).toString("hex"));
  // SDK XDR objects expose fields through accessors; use their JSON encoding
  // for a portable, serializable evidence record.
  const events = JSON.parse(JSON.stringify(transaction.events.contractEventsXdr)).flat();
  const vaultEvents = events.filter((event) => event.contract_id === vault).map((event) => event.body.v0);
  const usdcTransfers = events.filter((event) => event.contract_id === usdc && event.body.v0.topics[0]?.symbol === "transfer")
    .map((event) => ({
      from: event.body.v0.topics[1].address,
      to: event.body.v0.topics[2].address,
      amount: event.body.v0.data.i128,
    }));
  return {
    hash: [acceptedHash, rejectedHash][index],
    ledger: transaction.ledger,
    noteId: Buffer.from(result.note_id).toString("hex"),
    wireHash: createHash("sha256").update(wire).digest("hex"),
    wireBytes: wire.length,
    protocolVaultId: cheque.vault.toString("hex"),
    settler: invocation.args[1].address,
    ok: result.ok,
    reason: result.reason,
    fee: result.fee.toString(),
    vaultEvents,
    usdcTransfers,
  };
});

const [accepted, rejected] = proof;
assert.equal(accepted.ok, true);
assert.equal(accepted.reason, null);
assert.equal(accepted.fee, "100000");
assert.equal(accepted.usdcTransfers.length, 2);
assert.equal(accepted.usdcTransfers[0].from, vault);
assert.equal(accepted.usdcTransfers[0].amount, "10000");
assert.equal(accepted.usdcTransfers[1].from, vault);
assert.equal(accepted.usdcTransfers[1].to, accepted.settler);
assert.equal(accepted.usdcTransfers[1].amount, "100000");
assert.equal(accepted.vaultEvents.length, 1);
assert.equal(accepted.vaultEvents[0].topics[0].symbol, "settled");
assert.deepEqual(accepted.vaultEvents[0].data.vec, [{ bytes: accepted.noteId }, { i128: "100000" }]);
assert.equal(rejected.noteId, accepted.noteId);
assert.notEqual(rejected.wireHash, accepted.wireHash, "these must be two distinct cheques for one note");
assert.ok(rejected.ledger > accepted.ledger);
assert.equal(rejected.ok, false);
assert.equal(rejected.reason, "note-used");
assert.equal(rejected.fee, "0");
assert.equal(rejected.usdcTransfers.length, 0, "the rejected transaction must not transfer USDC");
assert.equal(rejected.vaultEvents.length, 1);
assert.equal(rejected.vaultEvents[0].topics[0].symbol, "rejected");
assert.deepEqual(rejected.vaultEvents[0].data.vec, [{ bytes: rejected.noteId }, { string: "note-used" }]);

console.log(JSON.stringify({
  observedAt: new Date().toISOString(), network: "testnet", rpcUrl, vault, usdc,
  protocolVaultId, deployedWasmHash: instanceData.executable.wasm,
  instanceLiveUntilLedger: instance.liveUntilLedgerSeq, transactions: proof,
}, null, 2));
