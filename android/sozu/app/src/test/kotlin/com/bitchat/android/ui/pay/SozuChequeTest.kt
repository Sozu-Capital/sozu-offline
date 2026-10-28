package com.bitchat.android.ui.pay

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SozuChequeTest {
    @Test
    fun decodesAStellarAccount() {
        val id = StellarStrKey.accountId("GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN")
        assertNotNull(id)
        assertEquals(32, id!!.size)
        assertEquals("3b9911380efe988ba0a8900eb1cfe44f366f7dbe946bed077240f7f624df15c5", id.joinToString("") { "%02x".format(it) })
    }

    @Test
    fun encodesTheKnownAccount() {
        val raw = "3b9911380efe988ba0a8900eb1cfe44f366f7dbe946bed077240f7f624df15c5"
            .chunked(2)
            .map { it.toInt(16).toByte() }
            .toByteArray()
        assertEquals("GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", StellarStrKey.encodeAccount(raw))
    }

    @Test
    fun contractAddressRoundTrips() {
        val raw = ByteArray(32) { (it + 3).toByte() }
        val encoded = StellarStrKey.encodeContract(raw)
        assertTrue(encoded.startsWith("C"))
        assertEquals(56, encoded.length)
        assertArrayEquals(raw, StellarStrKey.accountId(encoded))
    }

    @Test
    fun vaultUsesTheFrozenProtocolIdRatherThanTheContractAddress() {
        val id = SozuCheque.vaultId()
        assertEquals(32, id.size)
        assertEquals(
            "0101010101010101010101010101010101010101010101010101010101010101",
            id.joinToString("") { "%02x".format(it) },
        )
    }

    @Test
    fun chequeBodyIs179Bytes() {
        val body = SozuCheque.encodeBody(
            vault = SozuCheque.vaultId(),
            noteId = ByteArray(16),
            amount = SozuCheque.usdcMinor(500),
            fee = SozuCheque.DEMO_FEE,
            cap = SozuCheque.usdcMinor(500) + SozuCheque.DEMO_FEE,
            expirySeconds = 1_800_000_000L,
            payee = ByteArray(32) { 1 },
            owner = ByteArray(32) { 2 },
            deviceKey = ByteArray(33) { 3 },
        )
        assertEquals(179, body.size)
        assertEquals(1, body[0].toInt())
        assertEquals(50_000_000L, readU64(body, 50))
    }

    private fun readU64(body: ByteArray, offset: Int): Long {
        var v = 0L
        for (i in 7 downTo 0) v = (v shl 8) or (body[offset + i].toLong() and 0xff)
        return v
    }
}
