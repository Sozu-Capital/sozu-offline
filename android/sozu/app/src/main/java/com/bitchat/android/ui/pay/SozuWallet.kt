package com.bitchat.android.ui.pay

import android.app.Activity
import android.content.Context
import org.json.JSONObject

/**
 * The phone holds the P-256 cheque key. A laptop provisions a classic G owner
 * and deposits fresh faucet USDC; only its public receipt is imported here.
 */
object SozuWallet {
    fun ensure(context: Context, activity: Activity): String {
        val signer = DeviceChequeSigner(activity)
        signer.prepare()
        val receipt = receipt(context) ?: return ""
        val key = signer.compressedPublicKey().joinToString("") { "%02x".format(it) }
        return runCatching {
            receipt.validate(key, System.currentTimeMillis() / 1000L)
            receipt.owner
        }.getOrDefault("")
    }

    fun loadOrCreate(context: Context): String {
        val receipt = receipt(context) ?: return ""
        return runCatching {
            receipt.validate(receipt.deviceKey, System.currentTimeMillis() / 1000L)
            receipt.owner
        }.getOrDefault("")
    }

    fun lockedUntil(context: Context): Long = receipt(context)?.lockedUntil ?: 0L

    fun importReceipt(context: Context, activity: Activity, raw: String): String {
        require(raw.length <= 4096)
        val value = parseReceipt(JSONObject(raw))
        val key = DeviceChequeSigner(activity).compressedPublicKey().joinToString("") { "%02x".format(it) }
        value.validate(key, System.currentTimeMillis() / 1000L)
        // Reconstruct the public fields so pasted credentials can never be stored.
        val publicReceipt = JSONObject()
            .put("network", value.network).put("owner", value.owner)
            .put("deviceKey", value.deviceKey).put("contractId", value.contractId)
            .put("protocolVaultId", value.protocolVaultId).put("depositHash", value.depositHash)
            .put("lockedUntil", value.lockedUntil).put("collateral", value.collateral.toString())
        context.getSharedPreferences("sozu-pay", Context.MODE_PRIVATE).edit()
            .putString("ownerReceipt", publicReceipt.toString())
            .putString("account", value.owner).putString("owner", value.owner)
            .remove("tagSynced").apply()
        return value.owner
    }

    private fun receipt(context: Context): SozuProvisionedOwner? = runCatching {
        val raw = context.getSharedPreferences("sozu-pay", Context.MODE_PRIVATE)
            .getString("ownerReceipt", null) ?: return null
        parseReceipt(JSONObject(raw))
    }.getOrNull()

    private fun parseReceipt(json: JSONObject) = SozuProvisionedOwner(
        network = json.getString("network"), owner = json.getString("owner"),
        deviceKey = json.getString("deviceKey"), contractId = json.getString("contractId"),
        protocolVaultId = json.getString("protocolVaultId"), depositHash = json.getString("depositHash"),
        lockedUntil = json.getLong("lockedUntil"), collateral = json.getString("collateral").toLong(),
    )

    fun addressFromMeshText(content: String): String? {
        val line = content.lineSequence().firstOrNull { it.startsWith("sozu-wallet:") } ?: return null
        return line.removePrefix("sozu-wallet:").trim().uppercase().takeIf(::isValidStellarAddress)
    }

    fun tagFromMeshText(content: String): String? {
        val line = content.lineSequence().firstOrNull { it.startsWith("sozu-tag:") } ?: return null
        return normalizeSozuTag(line.removePrefix("sozu-tag:")).takeIf(::isValidSozuTag)
    }
}
