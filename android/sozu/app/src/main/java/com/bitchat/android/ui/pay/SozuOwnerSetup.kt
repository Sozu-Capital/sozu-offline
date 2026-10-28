package com.bitchat.android.ui.pay

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun SozuOwnerSetup(onLinked: (String) -> Unit) {
    val context = LocalContext.current
    val activity = context as? Activity
    var deviceKey by remember { mutableStateOf("") }
    var receipt by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        runCatching {
            requireNotNull(activity)
            DeviceChequeSigner(activity).compressedPublicKey().joinToString("") { "%02x".format(it) }
        }.onSuccess { deviceKey = it }.onFailure { error = "Unable to prepare this phone's signing key" }
    }
    Column(Modifier.sozuFrame().verticalScroll(rememberScrollState())) {
        Text("Testnet wallet setup", color = Color.White, fontSize = 28.sp)
        Text(
            "Use this device key to create and deposit a fresh faucet account on your laptop. Then paste only the public owner receipt below.",
            color = Color.White.copy(alpha = 0.75f), modifier = Modifier.padding(top = 20.dp),
        )
        Text("Keep wallet secrets on the laptop.", color = Color.White.copy(alpha = 0.75f), modifier = Modifier.padding(top = 12.dp))
        TextButton(enabled = deviceKey.isNotBlank(), onClick = {
            (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                .setPrimaryClip(ClipData.newPlainText("Sozu public device key", deviceKey))
        }) { Text("Copy public device key", color = Color.White) }
        Text(deviceKey, color = Color.White.copy(alpha = 0.6f), fontSize = 12.sp)
        OutlinedTextField(
            value = receipt, onValueChange = { receipt = it.take(4096); error = null },
            label = { Text("Public owner receipt") }, minLines = 4, maxLines = 8,
            modifier = Modifier.fillMaxWidth().padding(top = 20.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedTextColor = Color.White, unfocusedTextColor = Color.White,
                focusedBorderColor = Color.White, unfocusedBorderColor = Color.Gray,
            ),
        )
        TextButton(enabled = deviceKey.isNotBlank() && receipt.isNotBlank(), onClick = {
            if (activity != null) {
                runCatching { SozuWallet.importReceipt(context, activity, receipt) }
                    .onSuccess(onLinked)
                    .onFailure { error = "Receipt must be an unexpired testnet deposit for this phone's key" }
            }
        }) { Text("Link testnet account", color = Color.White) }
        error?.let { Text(it, color = Color(0xFFC4552A)) }
    }
}
