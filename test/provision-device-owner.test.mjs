import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import { provisionDeviceOwner } from "../scripts/provision-device-owner.mjs";

const deviceKey = "02de0da91a51db50590ecebe84f7708733152db212a04dae042563a84b9b7d66ce";
const depositHash = "8d28a366f5b2d7ce961fea170da2e0ffafae8260eb3540ff3648c57917c5b55a";

test("fresh faucet owner deposits for the phone key and exports only a public receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "sozu-owner-test-"));
  const outputDirectory = join(root, "session");
  const wallet = Keypair.random();
  let claimed = 0;
  try {
    const receipt = await provisionDeviceOwner({
      deviceKey, outputDirectory, now: 1_800_000_000,
      claimNewWallet: async () => {
        claimed++;
        return { success: true, network: "testnet", to: wallet.publicKey(), wallet: {
          generated: true, funded: true, trustline: true, address: wallet.publicKey(), secret: wallet.secret(),
        } };
      },
      deposit: async ({ signer, collateral, lockedUntil, deviceKey: key }) => {
        assert.equal(signer.publicKey(), wallet.publicKey());
        assert.equal(collateral, 100_000_000n);
        assert.equal(lockedUntil, 1_800_259_200n);
        assert.equal(key.toString("hex"), deviceKey);
        return depositHash;
      },
    });
    assert.equal(claimed, 1);
    assert.equal(receipt.owner, wallet.publicKey());
    assert.equal(receipt.protocolVaultId, "0101010101010101010101010101010101010101010101010101010101010101");
    const publicText = readFileSync(join(outputDirectory, "owner-receipt.json"), "utf8");
    assert.equal(publicText.includes(wallet.secret()), false);
    assert.equal(publicText.includes('"secret"'), false);
    assert.deepEqual(JSON.parse(publicText), receipt);
    assert.equal(JSON.parse(readFileSync(join(outputDirectory, "wallet-claim.private.json"), "utf8")).wallet.secret === wallet.secret(), true);
  } finally {
    // Only unlink files in the exact temporary directory created by this test.
    if (existsSync(outputDirectory)) {
      for (const name of readdirSync(outputDirectory)) rmSync(join(outputDirectory, name));
      rmdirSync(outputDirectory);
    }
    rmdirSync(root);
  }
});

test("refuses wallet storage inside a Git checkout before claiming funds", async () => {
  let claimed = false;
  await assert.rejects(provisionDeviceOwner({
    deviceKey, outputDirectory: fileURLToPath(new URL("../scripts/unused-private-owner", import.meta.url)),
    claimNewWallet: async () => { claimed = true; }, deposit: async () => depositHash,
  }), /outside every Git checkout/);
  assert.equal(claimed, false);
});

test("failed claim preserves the fresh private wallet locally and never deposits", async () => {
  const root = mkdtempSync(join(tmpdir(), "sozu-owner-test-"));
  const outputDirectory = join(root, "session");
  let deposited = false;
  try {
    await assert.rejects(provisionDeviceOwner({
      deviceKey, outputDirectory,
      claimNewWallet: async () => ({ success: false, reason: "ip_limit", wallet: { generated: true } }),
      deposit: async () => { deposited = true; },
    }), /Fresh faucet claim failed/);
    assert.equal(deposited, false);
    assert.equal(existsSync(join(outputDirectory, "wallet-claim.private.json")), true);
    assert.equal(existsSync(join(outputDirectory, "owner-receipt.json")), false);
  } finally {
    if (existsSync(outputDirectory)) {
      for (const name of readdirSync(outputDirectory)) rmSync(join(outputDirectory, name));
      rmdirSync(outputDirectory);
    }
    rmdirSync(root);
  }
});

test("invalid device key stops before claiming or depositing", async () => {
  let touchedNetwork = false;
  await assert.rejects(provisionDeviceOwner({
    deviceKey: "not-a-p256-key", outputDirectory: join(tmpdir(), "unused-sozu-owner"),
    claimNewWallet: async () => { touchedNetwork = true; },
    deposit: async () => { touchedNetwork = true; },
  }));
  assert.equal(touchedNetwork, false);
});
