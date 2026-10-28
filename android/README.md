# Sozu mesh APK

The installable Sozu pay app is a GitHub release of this repository. The asset is `sozu-offline-pay.apk`.

https://github.com/Sozu-Capital/sozu-offline/releases

`android/sozu/` is the Sozu change set: application id `capital.sozu.mesh`, the pay screen, and the cheque signer. It is applied onto bitchat-android at the pin in `forks.json`. That pin stays unmodified. Sozu releases are not published from `Sozu-Capital/bitchat-android`.

The mesh app is a derivative of bitchat-android and stays GPL-3.0. Corresponding source for a release is this overlay plus that pinned commit (`permissionlesstech/bitchat-android` at `forks.json` → `android.sha`).

```bash
./scripts/sync-forks.sh
./scripts/apply-android-overlay.sh
```

The next signed build is the **Sozu APK** workflow in this repository. It needs the `SOZU_STORE_B64` and `SOZU_STORE_PASS` Actions secrets on `Sozu-Capital/sozu-offline`.

## Assisted testnet onboarding

The phone signs cheques with its P-256 Android keystore key. The vault owner is a
fresh classic `G...` account, created on a laptop using the faucet CLI. Its Stellar
seed stays on that laptop and is used to authorize the deposit. The phone imports
only a public setup receipt. This is a demo setup flow, not a deployed passkey
smart account or automatic mobile funding.

1. Open the pay screen and copy **public device key** from **Testnet wallet setup**.
2. Install Node dependencies on the laptop (`npm ci`), then run:

   ```sh
   node scripts/provision-device-owner.mjs <phone-public-key-hex>
   ```

   The script executes `npx --yes @sozu/faucet@latest claim` without an address.
   The CLI creates a new classic account, funds it through Friendbot, adds the
   Circle testnet USDC trustline, and claims USDC. The script checks the fresh
   balance and deployed vault configuration before depositing 10 USDC for the
   supplied device key with a three-day lock. It never loads an existing owner
   or the demo wallet. If claiming or depositing fails, it stops.

3. The script prints the local session directory, public owner, deposit explorer
   link and path to `owner-receipt.json`. Copy only that public JSON into the
   phone's setup field and select **Link testnet account**. Keep
   `wallet-claim.private.json` local; it contains `wallet.secret` and must not be
   shared or committed. Both files are created outside the repository without
   overwriting an earlier session.
4. The phone validates the receipt's network, classic address checksum, device
   key, contract, protocol ID, lock expiry and deposit-hash format. Cheque expiry
   is capped at that lock. The receipt is a trusted operator setup record; the
   phone does not independently verify the deposit on-chain. Use the receipt
   produced by your own laptop script and check its explorer link.

The deployed contract address identifies where to call `deposit` and `settle`.
The cheque's internal vault ID is separately frozen as 32 bytes `0x01`. The
`SOZU1:` layout stays 179-byte body, 64-byte low-S P-256 signature, 243-byte wire.
The pay screen accepts classic `G...` recipients because the current vault
interprets those 32 bytes as an Ed25519 account. Such recipients need a Circle
USDC trustline.

`Android checks` compiles the overlay on the pinned upstream tree and runs the
Sozu payment unit tests without signing or publishing an APK. Before claiming
the mobile flow works, test the import, biometric signature, mesh transport and
submission endpoint on a physical phone. This change does not deploy the external
`/api/offline/submit` service.

On 2026-10-26, read-only integration checks found HTTP 404 from both GET and a
POST with an empty JSON object to `https://app.sozu.capital/api/offline/submit`.
No cheque was sent. That service must be made available and its settlement
authorization checked before claiming automatic upload from the phone works.
