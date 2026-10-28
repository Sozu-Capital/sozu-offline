package com.bitchat.android.ui.pay

import java.math.BigInteger
import java.security.SecureRandom

/** SOZU1 cheque body. 179 bytes. Signature is not part of the hash. */
object SozuCheque {
    const val BODY_BYTES = 179
    const val NETWORK_TESTNET = 1
    const val VAULT_CONTRACT = "CDSCQSVWKTYR7EUJK5EQXIFI4L2C4LCPQOIUYP6PMG6KW4O2BZGCRLLV"
    val DEMO_FEE = 100_000L

    // Config.vault_id is the frozen protocol ID, not the deployed C-address.
    fun vaultId(): ByteArray = ByteArray(32) { 1 }
    private val USDC = 10_000_000L
    private val ORDER = BigInteger("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16)

    fun usdcMinor(cents: Int): Long = cents.toLong() * (USDC / 100L)

    fun encodeBody(
        vault: ByteArray,
        noteId: ByteArray,
        amount: Long,
        fee: Long,
        cap: Long,
        expirySeconds: Long,
        payee: ByteArray,
        owner: ByteArray,
        deviceKey: ByteArray,
    ): ByteArray {
        require(vault.size == 32 && noteId.size == 16 && payee.size == 32 && owner.size == 32 && deviceKey.size == 33)
        val body = ByteArray(BODY_BYTES)
        body[0] = 1
        body[1] = NETWORK_TESTNET.toByte()
        vault.copyInto(body, 2)
        noteId.copyInto(body, 34)
        writeU64(body, 50, amount)
        writeU64(body, 58, fee)
        writeU64(body, 66, cap)
        writeU64(body, 74, expirySeconds)
        payee.copyInto(body, 82)
        owner.copyInto(body, 114)
        deviceKey.copyInto(body, 146)
        return body
    }

    fun randomNoteId(): ByteArray = ByteArray(16).also { SecureRandom().nextBytes(it) }

    fun frame(wire: ByteArray): String = "SOZU1:" + base64Url(wire)

    fun lowS(raw: ByteArray): ByteArray {
        require(raw.size == 64)
        val r = BigInteger(1, raw.copyOfRange(0, 32))
        var s = BigInteger(1, raw.copyOfRange(32, 64))
        val half = ORDER.shiftRight(1)
        if (s > half) s = ORDER.subtract(s)
        return fixed32(r) + fixed32(s)
    }

    fun derToLowS(der: ByteArray): ByteArray {
        var i = 0
        require(der[i++] == 0x30.toByte())
        val seqLen = der[i++].toInt() and 0xff
        require(der.size >= 2 + seqLen)
        require(der[i++] == 0x02.toByte())
        val rLen = der[i++].toInt() and 0xff
        val r = der.copyOfRange(i, i + rLen)
        i += rLen
        require(der[i++] == 0x02.toByte())
        val sLen = der[i++].toInt() and 0xff
        val s = der.copyOfRange(i, i + sLen)
        return lowS(fixed32(BigInteger(1, r)) + fixed32(BigInteger(1, s)))
    }

    private fun writeU64(body: ByteArray, offset: Int, value: Long) {
        var v = value
        for (i in 0 until 8) {
            body[offset + i] = (v and 0xff).toByte()
            v = v ushr 8
        }
    }

    private fun fixed32(n: BigInteger): ByteArray {
        val raw = n.toByteArray()
        val out = ByteArray(32)
        val src = if (raw.size > 32) raw.copyOfRange(raw.size - 32, raw.size) else raw
        src.copyInto(out, 32 - src.size)
        return out
    }

    private fun base64Url(bytes: ByteArray): String {
        return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }
}

object StellarStrKey {
    private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

    fun accountId(address: String): ByteArray? {
        val decoded = decode(address.trim().uppercase()) ?: return null
        if (decoded.isEmpty()) return null
        val version = decoded[0].toInt() and 0xff
        if (version != 48 && version != 16) return null
        // decode() has already verified and removed the two checksum bytes.
        if (decoded.size != 33) return null
        return decoded.copyOfRange(1, 33)
    }

    fun encodeAccount(publicKey: ByteArray): String = encode(48, publicKey)

    fun encodeContract(contractId: ByteArray): String = encode(16, contractId)

    private fun encode(version: Int, payload32: ByteArray): String {
        require(payload32.size == 32)
        val payload = ByteArray(33)
        payload[0] = version.toByte()
        payload32.copyInto(payload, 1)
        val crc = crc16(payload)
        val withCrc = payload + byteArrayOf((crc and 0xff).toByte(), ((crc shr 8) and 0xff).toByte())
        return base32(withCrc)
    }

    private fun base32(data: ByteArray): String {
        var bits = 0
        var value = 0
        val out = StringBuilder()
        for (b in data) {
            value = (value shl 8) or (b.toInt() and 0xff)
            bits += 8
            while (bits >= 5) {
                bits -= 5
                out.append(ALPHABET[(value shr bits) and 31])
            }
        }
        if (bits > 0) out.append(ALPHABET[(value shl (5 - bits)) and 31])
        return out.toString()
    }

    private fun decode(text: String): ByteArray? {
        if (text.isEmpty()) return null
        var bits = 0
        var value = 0
        val out = ArrayList<Byte>(text.length * 5 / 8)
        for (ch in text) {
            val idx = ALPHABET.indexOf(ch)
            if (idx < 0) return null
            value = (value shl 5) or idx
            bits += 5
            if (bits >= 8) {
                bits -= 8
                out.add(((value shr bits) and 0xff).toByte())
            }
        }
        val bytes = out.toByteArray()
        if (bytes.size < 3) return null
        val payload = bytes.copyOfRange(0, bytes.size - 2)
        val crc = (bytes[bytes.size - 2].toInt() and 0xff) or ((bytes[bytes.size - 1].toInt() and 0xff) shl 8)
        if (crc16(payload) != crc) return null
        return payload
    }

    private fun crc16(data: ByteArray): Int {
        var crc = 0
        for (b in data) {
            crc = crc xor ((b.toInt() and 0xff) shl 8)
            repeat(8) {
                crc = if (crc and 0x8000 != 0) ((crc shl 1) xor 0x1021) and 0xffff else (crc shl 1) and 0xffff
            }
        }
        return crc
    }
}
