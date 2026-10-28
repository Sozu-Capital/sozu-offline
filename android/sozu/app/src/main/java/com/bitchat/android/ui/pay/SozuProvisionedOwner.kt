package com.bitchat.android.ui.pay

/** Public receipt from the laptop that created and deposited a fresh faucet account. */
data class SozuProvisionedOwner(
    val network: String,
    val owner: String,
    val deviceKey: String,
    val contractId: String,
    val protocolVaultId: String,
    val depositHash: String,
    val lockedUntil: Long,
    val collateral: Long,
) {
    fun validate(expectedDeviceKey: String, now: Long) {
        require(network == "testnet")
        require(owner.length == 56 && owner.startsWith("G") && StellarStrKey.accountId(owner) != null)
        require(deviceKey.matches(Regex("0[23][0-9a-f]{64}")))
        require(deviceKey == expectedDeviceKey)
        require(contractId == SozuCheque.VAULT_CONTRACT)
        require(protocolVaultId == SozuCheque.vaultId().joinToString("") { "%02x".format(it) })
        require(depositHash.matches(Regex("[0-9a-f]{64}")))
        require(lockedUntil > now)
        require(collateral > SozuCheque.DEMO_FEE)
    }
}
