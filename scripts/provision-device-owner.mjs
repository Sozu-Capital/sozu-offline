import { execFile } from "node:child_process";
import { ECDH, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  BASE_FEE, Contract, Keypair, nativeToScVal, Networks, rpc, scValToNative, StrKey, TransactionBuilder, xdr,
} from "@stellar/stellar-sdk";
import { TESTNET_RPC, TESTNET_VAULT } from "./witness-upload.mjs";

const issuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const usdcContract = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const collateral = 100_000_000n; // 10 fresh testnet USDC; never use the demo owner.
const execFileAsync = promisify(execFile);

export async function provisionDeviceOwner({
  deviceKey, outputDirectory, claimNewWallet, deposit, now = Math.floor(Date.now() / 1000),
}) {
  if (!/^0[23][a-f0-9]{64}$/.test(deviceKey ?? "")) throw new Error("Expected the phone's 33-byte compressed P-256 public key");
  const key = Buffer.from(deviceKey, "hex");
  ECDH.convertKey(key, "prime256v1"); // Validate the curve point before claiming funds.
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("Invalid provisioning time");
  const output = resolve(outputDirectory);
  let parent = realpathSync(dirname(output));
  // Check every ancestor, including linked worktrees and other local checkouts.
  while (true) {
    if (existsSync(join(parent, ".git"))) throw new Error("Wallet output must be outside every Git checkout");
    const ancestor = dirname(parent);
    if (ancestor === parent) break;
    parent = ancestor;
  }
  // Refuse to reuse any session directory or overwrite an earlier wallet.
  mkdirSync(output, { mode: 0o700 });
  const claim = await claimNewWallet();
  writeFileSync(join(output, "wallet-claim.private.json"), JSON.stringify(claim, null, 2), { flag: "wx", mode: 0o600 });
  if (!claim.success || claim.network !== "testnet" || !claim.wallet?.generated || !claim.wallet.funded || !claim.wallet.trustline) {
    throw new Error("Fresh faucet claim failed; any generated wallet remains in the local private file. No deposit submitted.");
  }
  let signer;
  try { signer = Keypair.fromSecret(claim.wallet.secret); }
  catch { throw new Error("Faucet did not return a usable local wallet; no deposit submitted"); }
  const owner = signer.publicKey();
  if (claim.to !== owner || claim.wallet.address !== owner) throw new Error("Faucet recipient mismatch; no deposit submitted");
  const lockedUntil = BigInt(now + 3 * 24 * 3600);
  const depositHash = await deposit({ signer, deviceKey: key, collateral, lockedUntil });
  if (!/^[a-f0-9]{64}$/.test(depositHash ?? "")) throw new Error("Deposit confirmation missing; no public receipt exported");
  const receipt = {
    network: "testnet", owner, deviceKey,
    contractId: TESTNET_VAULT, protocolVaultId: "01".repeat(32),
    depositHash, lockedUntil: Number(lockedUntil), collateral: collateral.toString(),
  };
  writeFileSync(join(output, "owner-receipt.json"), JSON.stringify(receipt, null, 2), { flag: "wx", mode: 0o600 });
  return receipt;
}

async function claimFromFaucet() {
  // Fixed command only. Do not interpolate the device key or user paths into a shell.
  const command = process.platform === "win32"
    ? ["cmd.exe", ["/d", "/s", "/c", "npx --yes @sozu/faucet@latest claim"]]
    : ["npx", ["--yes", "@sozu/faucet@latest", "claim"]];
  let stdout;
  try {
    ({ stdout } = await execFileAsync(...command, { windowsHide: true, timeout: 180_000, maxBuffer: 1024 * 1024 }));
  } catch (error) {
    // Failed claims can still contain a generated wallet. Preserve it locally.
    stdout = error.stdout;
  }
  try { return JSON.parse(stdout); }
  catch { throw new Error("Faucet CLI returned no usable claim JSON. No deposit submitted."); }
}

async function depositOwner({ signer, deviceKey, collateral: amount, lockedUntil }) {
  const accountResponse = await fetch(`https://horizon-testnet.stellar.org/accounts/${signer.publicKey()}`, { signal: AbortSignal.timeout(20_000) });
  if (!accountResponse.ok) throw new Error("New testnet account is unavailable; no deposit submitted");
  const accountData = await accountResponse.json();
  const balance = accountData.balances.find((entry) => entry.asset_code === "USDC" && entry.asset_issuer === issuer);
  const [whole, fraction = ""] = (balance?.balance ?? "0").split(".");
  const available = BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, "0"));
  if (available < amount) throw new Error("Fresh wallet has insufficient USDC collateral; no deposit submitted");
  const server = new rpc.Server(TESTNET_RPC);
  const instance = await server.getContractData(TESTNET_VAULT, xdr.ScVal.scvLedgerKeyContractInstance());
  const config = JSON.parse(JSON.stringify(instance)).val.contract_data.val.contract_instance.storage
    .find((entry) => entry.key.vec?.[0]?.symbol === "Config").val.map;
  if (config.find((entry) => entry.key.symbol === "vault_id").val.bytes !== "01".repeat(32)
      || config.find((entry) => entry.key.symbol === "token").val.address !== usdcContract) {
    throw new Error("Deployed vault configuration differs from the frozen demo; no deposit submitted");
  }
  const account = await server.getAccount(signer.publicKey());
  const transaction = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(TESTNET_VAULT).call("deposit",
      xdr.ScVal.scvBytes(StrKey.decodeEd25519PublicKey(signer.publicKey())),
      xdr.ScVal.scvBytes(deviceKey), nativeToScVal(amount, { type: "i128" }), nativeToScVal(lockedUntil, { type: "u64" })))
    .setTimeout(30).build();
  const prepared = await server.prepareTransaction(transaction);
  prepared.sign(signer);
  const sent = await server.sendTransaction(prepared);
  if (sent.status !== "PENDING") throw new Error("Deposit submission failed; wallet remains in the local private file");
  const final = await server.pollTransaction(sent.hash, { attempts: 30, sleepStrategy: () => 1000 });
  if (final.status !== "SUCCESS" || scValToNative(final.returnValue) !== null) {
    throw new Error(`Deposit not confirmed: ${sent.hash}. Wallet remains in the local private file.`);
  }
  return sent.hash;
}

async function main() {
  const deviceKey = process.argv[2];
  if (!deviceKey || process.argv.length > 4) throw new Error("Usage: node scripts/provision-device-owner.mjs <phone-public-key-hex> [new-output-directory-outside-repo]");
  const base = join(process.env.LOCALAPPDATA || join(homedir(), ".local", "share"), "sozu-device-onboarding");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const outputDirectory = process.argv[3] || join(base, randomUUID());
  console.log(`Local session directory: ${outputDirectory}`);
  const receipt = await provisionDeviceOwner({ deviceKey, outputDirectory, claimNewWallet: claimFromFaucet, deposit: depositOwner });
  console.log(`Owner: ${receipt.owner}`);
  console.log(`Deposit: https://stellar.expert/explorer/testnet/tx/${receipt.depositHash}`);
  console.log(`Import only the public receipt: ${join(outputDirectory, "owner-receipt.json")}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
