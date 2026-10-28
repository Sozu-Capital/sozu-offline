package com.bitchat.android.ui.pay

import org.junit.Assert.assertTrue
import org.junit.Test

class SozuProvisionedOwnerTest {
    private val key = "02de0da91a51db50590ecebe84f7708733152db212a04dae042563a84b9b7d66ce"
    private val receipt = SozuProvisionedOwner(
        network = "testnet",
        owner = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        deviceKey = key,
        contractId = "CDSCQSVWKTYR7EUJK5EQXIFI4L2C4LCPQOIUYP6PMG6KW4O2BZGCRLLV",
        protocolVaultId = "0101010101010101010101010101010101010101010101010101010101010101",
        depositHash = "8d28a366f5b2d7ce961fea170da2e0ffafae8260eb3540ff3648c57917c5b55a",
        lockedUntil = 2_000_000_000L,
        collateral = 100_000_000L,
    )

    @Test
    fun acceptsAPublicClassicOwnerReceiptForThisDeviceAndVault() {
        receipt.validate(key, 1_800_000_000L)
    }

    @Test
    fun refusesReceiptsForAnotherDeviceNetworkOrVaultAndExpiredDeposits() {
        val invalid = listOf(
            receipt.copy(network = "mainnet"),
            receipt.copy(owner = "CDSCQSVWKTYR7EUJK5EQXIFI4L2C4LCPQOIUYP6PMG6KW4O2BZGCRLLV"),
            receipt.copy(owner = receipt.owner.dropLast(1) + "A"),
            receipt.copy(deviceKey = "03" + key.drop(2)),
            receipt.copy(contractId = receipt.owner),
            receipt.copy(protocolVaultId = "e4284ab654f11f928957490ba0a8e2f42e2c4f83914c3fcf61bcab71da0e4c28"),
            receipt.copy(lockedUntil = 1_800_000_000L),
            receipt.copy(collateral = 100_000L),
            receipt.copy(depositHash = "not-a-transaction"),
        )
        invalid.forEach { assertTrue(runCatching { it.validate(key, 1_800_000_000L) }.isFailure) }
    }
}
