bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id; // Obtenemos el ID del mensaje actual
    const data = query.data;

    if (data === 'status') {
        bot.answerCallbackQuery(query.id, { text: "Consultando servidores..." });
        await mostrarServidores(chatId);
    }

    if (data.startsWith('pwr_')) {
        const [_, action, srvId] = data.split('_');
        bot.answerCallbackQuery(query.id, { text: `Enviando ${action}...` });
        
        const url = `${host}/api/client/servers/${srvId}/power`;
        
        try {
            const srvInfo = await client.getServerDetails(srvId);
            const serverName = srvInfo.name || srvId;

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({ signal: action })
            });

            if (response.status === 204 || response.ok) {
                // CAMBIO CLAVE: En lugar de bot.sendMessage, usamos editMessageText
                // Esto reemplaza el texto del mensaje que tenía los botones
                bot.editMessageText(`✅ Servidor: **${serverName}**\nSeñal **${action.toUpperCase()}** enviada con éxito.`, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown'
                });

                // Opcional: Después de 3 segundos, podrías volver a mostrar el menú,
                // pero por ahora esto evitará que se acumulen mensajes nuevos.
            } else {
                const errorData = await response.json().catch(() => ({}));
                const detail = errorData.errors ? errorData.errors[0].detail : "Error";
                bot.editMessageText(`❌ Error en **${serverName}**: ${detail}`, {
                    chat_id: chatId,
                    message_id: messageId
                });
            }
        } catch (err) {
            bot.editMessageText(`❌ Error de conexión: ${err.message}`, {
                chat_id: chatId,
                message_id: messageId
            });
        }
    }
});
