package com.bitchat.android.ui.pay

import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.bitchat.android.ui.ChatViewModel
import com.google.accompanist.permissions.ExperimentalPermissionsApi
import com.google.accompanist.permissions.isGranted
import com.google.accompanist.permissions.rememberPermissionState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private val keys = listOf("1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "del")

@OptIn(ExperimentalPermissionsApi::class)
@Composable
fun SozuPayScreen(
    viewModel: ChatViewModel,
    initialPeer: String? = null,
    onPayPeerOpened: () -> Unit = {},
    onOpenChat: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val camera = rememberPermissionState(android.Manifest.permission.CAMERA)
    val prefs = remember { context.getSharedPreferences("sozu-pay", Context.MODE_PRIVATE) }
    val peers by viewModel.connectedPeers.collectAsStateWithLifecycle()
    val names by viewModel.peerNicknames.collectAsStateWithLifecycle()
    val meshMessages by viewModel.messages.collectAsStateWithLifecycle()
    val privateChats by viewModel.privateChats.collectAsStateWithLifecycle()
    var owner by remember { mutableStateOf("") }
    var myTag by remember { mutableStateOf(SozuTag.current(context).orEmpty()) }
    val announced = remember { mutableSetOf<String>() }

    var digits by remember { mutableStateOf("") }
    var selected by remember { mutableStateOf<String?>(null) }
    var payee by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var status by remember { mutableStateOf<String?>(null) }
    var scanning by remember { mutableStateOf(false) }
    var sending by remember { mutableStateOf(false) }

    val cents = centsFromDigits(digits)
    val ownerOk = owner.takeIf { it.startsWith("G") && StellarStrKey.accountId(it) != null }
    val payeeOk = payee.takeIf { it.startsWith("G") && StellarStrKey.accountId(it) != null }
    val canSend = selected != null && cents > 0 && ownerOk != null && payeeOk != null && !sending

    fun rememberPayee(peerId: String, address: String) {
        payee = address
        prefs.edit().putString("payee:$peerId", address).apply()
    }

    fun applyInput(raw: String) {
        val parsed = parseSozuPayInput(raw)
        val address = parsed?.address
        if (address == null) {
            error = "Paste a Stellar address or a Sozu QR"
            return
        }
        if (!address.startsWith("G") || StellarStrKey.accountId(address) == null) {
            error = "This testnet vault pays classic G accounts"
            return
        }
        val peer = selected
        if (peer == null) {
            error = "Tap someone first"
            return
        }
        rememberPayee(peer, address)
        error = null
    }

    LaunchedEffect(Unit) {
        val activity = context as? Activity
        if (activity != null) {
            runCatching { owner = SozuWallet.ensure(context, activity) }
        }
        myTag = SozuTag.current(context).orEmpty()
        if (myTag.isNotBlank()) viewModel.setNickname(myTag)
    }

    LaunchedEffect(owner, myTag) {
        if (ownerOk == null || myTag.isBlank() || SozuTag.synced(context) == myTag) return@LaunchedEffect
        val saved = withContext(Dispatchers.IO) { SozuDirectory.publish(myTag, owner) }
        if (saved) SozuTag.markSynced(context, myTag)
    }

    LaunchedEffect(peers, owner, myTag) {
        if (!isValidStellarAddress(owner)) return@LaunchedEffect
        val line = if (myTag.isNotBlank()) "sozu-wallet:$owner\nsozu-tag:$myTag" else "sozu-wallet:$owner"
        peers.forEach { peer ->
            if (!announced.add("$peer:$owner")) return@forEach
            viewModel.sendToPeer(peer, line) { accepted ->
                if (!accepted) announced.remove("$peer:$owner")
            }
        }
    }

    LaunchedEffect(meshMessages, privateChats, selected) {
        val mine = viewModel.myPeerID
        fun learn(peerId: String?, content: String) {
            content.lineSequence().firstOrNull { it.startsWith("SOZU1:") }?.let { frame ->
                SozuPending.remember(context, frame)
            }
            if (peerId.isNullOrBlank() || peerId == mine) return
            val address = SozuWallet.addressFromMeshText(content)
            val tag = SozuWallet.tagFromMeshText(content)
            if (tag != null) prefs.edit().putString("peerTag:$peerId", tag).apply()
            if (address != null) {
                prefs.edit().putString("payee:$peerId", address).apply()
                if (selected == peerId) payee = address
            }
        }
        meshMessages.forEach { learn(it.senderPeerID, it.content) }
        privateChats.forEach { (_, items) ->
            items.forEach { learn(it.senderPeerID, it.content) }
        }
    }

    LaunchedEffect(initialPeer) {
        val peer = initialPeer ?: return@LaunchedEffect
        selected = peer
        payee = prefs.getString("payee:$peer", "") ?: ""
        digits = ""
        error = null
        status = null
        onPayPeerOpened()
    }

    LaunchedEffect(selected, payee, owner) {
        val peer = selected ?: return@LaunchedEffect
        if (payee.isNotBlank() || !isValidStellarAddress(owner)) return@LaunchedEffect
        val tag = prefs.getString("peerTag:$peer", null) ?: return@LaunchedEffect
        if (!SozuPending.online(context)) return@LaunchedEffect
        val address = withContext(Dispatchers.IO) { SozuPending.resolveTag(tag) } ?: return@LaunchedEffect
        prefs.edit().putString("payee:$peer", address).apply()
        if (selected == peer) payee = address
    }

    DisposableEffect(context, owner) {
        val manager = context.getSystemService(ConnectivityManager::class.java)
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                scope.launch {
                    val hash = withContext(Dispatchers.IO) { SozuPending.flush(context, owner) }
                    if (hash != null) status = "Submitted. app.sozu.capital/offline"
                }
            }
        }
        var registered = false
        if (manager != null) {
            runCatching {
                manager.registerDefaultNetworkCallback(callback)
                registered = true
            }
        }
        onDispose {
            if (registered) runCatching { manager?.unregisterNetworkCallback(callback) }
        }
    }

    if (ownerOk == null) {
        SozuOwnerSetup(onLinked = { owner = it })
        return
    }

    if (scanning) {
        QrOverlay(
            granted = camera.status.isGranted,
            onRequest = { camera.launchPermissionRequest() },
            onClose = { scanning = false },
            onScan = { raw ->
                scanning = false
                applyInput(raw)
            },
        )
        return
    }

    if (selected == null) {
        PeopleHome(
            owner = owner,
            tag = myTag,
            peers = peers,
            names = names,
            onOpenChat = onOpenChat,
            onPick = { peerId ->
                selected = peerId
                payee = prefs.getString("payee:$peerId", "") ?: ""
                digits = ""
                error = null
                status = null
            },
        )
        return
    }

    val peerId = selected ?: return
    val label = names[peerId]?.takeIf { it.isNotBlank() }
        ?: prefs.getString("peerTag:$peerId", null)
        ?: "Nearby"
    Column(modifier = Modifier.sozuFrame()) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(top = 4.dp),
        ) {
            TextButton(onClick = {
                selected = null
                digits = ""
                error = null
                status = null
            }) { Text("Back", color = Color.White.copy(alpha = 0.7f)) }
            Text(
                text = label,
                color = Color.White,
                fontSize = 16.sp,
                modifier = Modifier.weight(1f),
                textAlign = TextAlign.Center,
            )
            Text(
                text = if (myTag.isNotBlank()) "$$myTag" else shortAddress(owner),
                color = Color.White.copy(alpha = 0.4f),
                fontSize = 12.sp,
            )
        }
        Text(
            text = formatCents(cents),
            color = Color.White,
            fontSize = 48.sp,
            fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
        )
        Text(
            text = if (payeeOk != null) shortAddress(payeeOk) else "Waiting for their wallet",
            color = Color.White.copy(alpha = 0.45f),
            fontSize = 13.sp,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
        val note = error ?: status
        if (note != null) {
            Text(
                text = note,
                color = if (error != null) Color(0xFFC4552A) else Color.White.copy(alpha = 0.55f),
                fontSize = 12.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
            )
        }
        Spacer(modifier = Modifier.weight(1f))
        Column(modifier = Modifier.fillMaxWidth()) {
            keys.chunked(3).forEach { row ->
                Row(modifier = Modifier.fillMaxWidth()) {
                    row.forEach { key ->
                        Box(
                            modifier = Modifier.weight(1f).height(48.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            when (key) {
                                "" -> Unit
                                "del" -> TextButton(onClick = {
                                    if (digits.isNotEmpty()) digits = digits.dropLast(1)
                                }) { Text("⌫", color = Color.White.copy(alpha = 0.7f), fontSize = 20.sp) }
                                else -> TextButton(onClick = {
                                    if (digits.length < 8) digits += key
                                    status = null
                                }) { Text(key, color = Color.White, fontSize = 24.sp) }
                            }
                        }
                    }
                }
            }
        }
        TextButton(
            onClick = {
                val activity = context as? Activity
                if (activity == null || ownerOk == null || payeeOk == null) {
                    error = if (payeeOk == null) "Waiting for their wallet" else "Wallet is not ready"
                    return@TextButton
                }
                sending = true
                error = null
                status = "Confirm with passkey"
                SozuSendHaptic.begin(context, scope)
                scope.launch {
                    try {
                        val signer = DeviceChequeSigner(activity)
                        val amount = SozuCheque.usdcMinor(cents)
                        val payeeId = StellarStrKey.accountId(payeeOk)
                            ?: throw IllegalArgumentException("That Stellar address is not valid")
                        val ownerId = StellarStrKey.accountId(ownerOk)
                            ?: throw IllegalArgumentException("Your Stellar address is not valid")
                        val now = System.currentTimeMillis() / 1000L
                        val lockedUntil = SozuWallet.lockedUntil(context)
                        if (lockedUntil <= now) {
                            owner = ""
                            throw IllegalStateException("Testnet deposit expired; link a fresh account")
                        }
                        val body = SozuCheque.encodeBody(
                            vault = SozuCheque.vaultId(),
                            noteId = SozuCheque.randomNoteId(),
                            amount = amount,
                            fee = SozuCheque.DEMO_FEE,
                            cap = amount + SozuCheque.DEMO_FEE,
                            expirySeconds = minOf(
                                now + 7L * 24L * 3600L,
                                lockedUntil,
                            ),
                            payee = payeeId,
                            owner = ownerId,
                            deviceKey = signer.compressedPublicKey(),
                        )
                        val frame = SozuCheque.frame(body + signer.sign(body))
                        viewModel.sendToPeer(peerId, frame) { accepted ->
                            sending = false
                            if (accepted) {
                                SozuSendHaptic.finish(context)
                                SozuPending.remember(context, frame)
                                digits = ""
                                status = "Cheque signed. It leaves when a phone is online."
                                error = null
                                scope.launch {
                                    val hash = withContext(Dispatchers.IO) { SozuPending.flush(context, owner) }
                                    if (hash != null) status = "Submitted. app.sozu.capital/offline"
                                }
                            } else {
                                SozuSendHaptic.stop(context)
                                error = "Not sent"
                            }
                        }
                    } catch (e: Exception) {
                        SozuSendHaptic.stop(context)
                        sending = false
                        error = e.message ?: "Could not sign"
                    }
                }
            },
            enabled = canSend,
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 8.dp, bottom = 8.dp)
                .background(
                    if (canSend) Color.White else Color.White.copy(alpha = 0.2f),
                    RoundedCornerShape(28.dp),
                ),
        ) {
            Text(
                text = if (sending) "Signing…" else "Send",
                color = Color.Black,
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(vertical = 8.dp),
            )
        }
    }
}

@Composable
private fun PeopleHome(
    owner: String,
    tag: String,
    peers: List<String>,
    names: Map<String, String>,
    onOpenChat: () -> Unit,
    onPick: (String) -> Unit,
) {
    Column(modifier = Modifier.sozuFrame()) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(top = 8.dp),
        ) {
            Text(
                text = "SOZU",
                color = Color.White.copy(alpha = 0.45f),
                fontSize = 12.sp,
                letterSpacing = 2.sp,
                modifier = Modifier.weight(1f),
            )
            Text(
                text = if (tag.isNotBlank()) "$$tag" else shortAddress(owner),
                color = Color.White.copy(alpha = 0.45f),
                fontSize = 12.sp,
            )
            TextButton(onClick = onOpenChat) { Text("Chat", color = Color.White.copy(alpha = 0.4f)) }
        }
        Text(
            text = if (peers.isEmpty()) "Looking for people nearby" else "Tap someone to pay",
            color = Color.White,
            fontSize = 22.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(top = 28.dp, bottom = 20.dp),
        )
        Row(
            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            peers.forEach { peerId ->
                val label = names[peerId]?.takeIf { it.isNotBlank() } ?: peerId.take(4)
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    modifier = Modifier.padding(end = 18.dp).clickable { onPick(peerId) },
                ) {
                    Box(
                        modifier = Modifier.size(76.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.14f)),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(label.take(1).uppercase(), color = Color.White, fontSize = 26.sp, fontWeight = FontWeight.SemiBold)
                    }
                    Text(label.take(12), color = Color.White.copy(alpha = 0.7f), fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp))
                }
            }
        }
    }
}

@Composable
private fun QrOverlay(
    granted: Boolean,
    onRequest: () -> Unit,
    onClose: () -> Unit,
    onScan: (String) -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black)
            .statusBarsPadding()
            .navigationBarsPadding(),
    ) {
        if (granted) {
            SozuQrScanner(onScan = onScan)
        } else {
            TextButton(onClick = onRequest, modifier = Modifier.align(Alignment.Center)) {
                Text("Allow camera", color = Color.White)
            }
        }
        TextButton(onClick = onClose, modifier = Modifier.align(Alignment.TopStart).padding(12.dp)) {
            Text("Close", color = Color.White)
        }
    }
}
