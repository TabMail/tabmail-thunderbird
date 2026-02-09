# ChatLink Implementation TODOs

## Remaining Work

### Message Relay Improvements

- [ ] **Relay tool/thinking messages for better feedback**
  - Currently only final responses are relayed to WhatsApp
  - Should relay intermediate "thinking" bubbles and tool execution status
  - Provides better UX for users waiting on WhatsApp during long operations
  - Consider throttling to avoid WhatsApp rate limits

### Timeout Handling

- [ ] **Set timeout for WhatsApp-initiated FSM tool calls (5 min max)**
  - WhatsApp sessions can disconnect without notice
  - FSM tools that await user confirmation should timeout gracefully
  - After timeout, auto-cancel the FSM session and notify user
  - Prevents zombie sessions waiting indefinitely for confirmation

### Future Enhancements

- [ ] Support for message attachments (WhatsApp -> Thunderbird)
- [ ] Support for sending attachments (Thunderbird -> WhatsApp)
- [ ] Read receipts / delivery status
- [ ] Multi-device support (same WhatsApp on multiple TB instances)
