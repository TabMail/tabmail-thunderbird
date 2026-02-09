# ChatLink Implementation TODOs

## Completed

### Message Relay Improvements

- [x] **Relay tool/thinking messages for better feedback**
  - Relays "Thinking..." status when LLM is processing
  - Relays tool execution status (e.g., "Searching emails...")
  - Uses italic formatting for subtle appearance on WhatsApp

### Timeout Handling

- [x] **Set timeout for WhatsApp-initiated FSM tool calls (5 min max)**
  - FSM tools that await user confirmation timeout after 5 minutes (configurable)
  - After timeout, auto-cancels the FSM session and notifies user
  - Sends proper error to LLM so it knows user didn't respond
  - Config: `CHAT_SETTINGS.chatLinkFsmTimeoutMs` (default: 300000ms)

## Remaining Work

### Device Linking

- [ ] **Single WhatsApp number per TB instance enforcement**
  - A single WhatsApp number should only be paired with one TB instance
  - Attempting to link to a new device should warn user that previous link will disconnect
  - Worker should track active device and invalidate old sessions on re-link

### Future Enhancements

- [ ] Support for message attachments (WhatsApp -> Thunderbird)
- [ ] Support for sending attachments (Thunderbird -> WhatsApp)
- [ ] Read receipts / delivery status
- [ ] Multi-device support (same WhatsApp on multiple TB instances)
