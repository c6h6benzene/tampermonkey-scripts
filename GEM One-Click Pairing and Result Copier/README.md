# GEM → PurpleFox results

Version 2.1.1 provides **Send Pairings to PurpleFox** and **Send Results to PurpleFox** to the left of **Accept All Reports**, plus clipboard result export and a copyable debug log in Tampermonkey's menu. Pairing imports automatically accept table-range changes. Successful writes do not need to echo every written row.

## Install or update

1. Open the existing script in Tampermonkey (or choose **Create a new script**).
2. Replace the editor contents with `GEM PurpleFox Copy Results.user.js` and save. Allow its new PurpleFox site access and userscript storage/tab permissions if Tampermonkey asks.
3. Reload the GEM round's report page.
4. Make sure PurpleFox has the correct current round, then click **Send Pairings to PurpleFox** or **Send Results to PurpleFox**. Pairing imports set the table range automatically; result imports use the configured range.

The script opens the destination in a new PurpleFox tab. It uses your existing PurpleFox login. If you are logged out, log in in that tab and the transfer continues. It reports the final import result in both tabs. No user token needs to be copied into the script.

## Tournament destinations

Calling Kyoto (GEM `488942`) defaults to:

<https://eor-us.purple-fox.fr/tournament/720567fe-2fcd-4cc1-8f65-3c70b0d46918?role=scorekeeper>

For another GEM tournament, the first send asks for its PurpleFox tournament URL and remembers it by GEM tournament ID, across rounds. Change the saved URL from **Tampermonkey → Set PurpleFox destination for this tournament** while on that GEM tournament's report page. Only tournament URLs on `eor-us.purple-fox.fr` are accepted.

## Pairing imports

**Send Pairings to PurpleFox** sends the current round's pairings to the same saved destination as the results button. It also appears in Tampermonkey's menu.

The script reads GEM's **Pairings by table** print page at `/gem/<tournament>/run/<round>/print/?order=table` using your signed-in GEM session. It converts the print table into the tab-separated text accepted by PurpleFox's FAB pairing importer: table, player 1, GEM ID, player 2, GEM ID, and points. It checks that the print page has the same tables and player IDs as the report page before sending.

If the print page cannot be read, the script constructs PurpleFox's alternative table/name/GEM-ID format directly from the report's HTML. That includes hidden matches and byes and does not require result dropdowns. The report page does not contain player points, so this fallback sends null points and says so in the completion message.

The pairing data updates table/player/point fields, as in PurpleFox's native pairing importer. It does not submit result values, change the at-stage flag, or mark tables done. Set the correct round in PurpleFox first. A print page whose pairings differ from the report page stops the transfer and asks you to refresh GEM.

When the imported pairings' smallest or largest table number differs from PurpleFox's range, the script updates **First Table** and **Last Table** before sending the pairings. This is equivalent to choosing **Yes / Change table to …** in PurpleFox's range prompt, including when the range shrinks or its starting table changes. Matching ranges need no update. The completion message and debug log report range changes. If the range update fails, pairings are not sent; if it succeeds but the pairing import fails, the error says the range was already updated.

## Result imports

- Every match on the GEM page is sent, including rows hidden by **Hide Complete** or the table filter.
- The current dropdown value is sent: `1WIN`, `2WIN`, `DRAW`, `LOSSALL`, or `null` for unfinished matches.
- As in PurpleFox's native FAB importer, the script updates the destination's current table records, marks finished results as at stage, and marks completed tables **done**. Unfinished results are included and can replace previous results with `null`.
- Existing player scores are preserved, including when seats are reversed. Other table fields are left to PurpleFox.
- The GEM and PurpleFox round numbers must match, and every exported table must fit inside PurpleFox's configured range. Mismatches produce an error before writing. The script does not change the round number or table range.
- The button reads GEM's current page. It does not accept pending reports or submit GEM results. Accept reports and refresh GEM first when necessary.
- If saving results succeeds but updating table statuses fails, the message explicitly says the results were saved. Check PurpleFox before sending again. Writes are not automatically retried.
- Writes use the same minimal response behavior as PurpleFox's native upsert: a successful HTTP response is accepted without requiring returned row copies. Read responses are still validated, and HTTP errors still stop the transfer.

## View the error log

In the **PurpleFox tab opened by the send button**, press **F12** or **Ctrl+Shift+J**, open **Console**, and filter for **GEM PurpleFox**. Requests log the resource, HTTP status, submitted/returned row counts, and elapsed time. Server failures include the error code, message, details, and hint when supplied.

To inspect the original response, open **Network → Fetch/XHR**, enable **Preserve log**, and select the `tables` or `table_status` POST request. Its **Response** tab contains the server's response. Developer Tools must be open when the request is made to capture it; the previous version did not save a debug log.

After updating the script, **Tampermonkey → Copy PurpleFox debug log** works on either GEM or PurpleFox. It copies the latest 100 log entries, including recent failures, even after a tab reload. Logs omit request headers and request bodies. Server error details are retained, with bearer/JWT tokens redacted. The script does not automatically retry a failed transfer.

## Copy JSON instead

Choose **Tampermonkey → PurpleFox Export (copy JSON)**. It copies the same compact JSON array as the original extractor:

```json
[{"tableNumber":1,"playerName1":"Puttaree, Chanon","playerGameId1":"88422745","playerName2":"ZHOU, Xingyu","playerGameId2":"26845677","result":"2WIN"}]
```

## Implementation and verification

The same userscript runs on GEM and PurpleFox. Tampermonkey storage carries a single transfer's data between the tabs: print-style text for pairings, or structured match records for results. The PurpleFox tab uses its own existing Supabase session to make the native importer's `tables` upserts, plus `table_status` upserts for completed results. The login token stays on PurpleFox; it is not saved in shared userscript storage. Transfer data is removed when the transfer succeeds or fails, and pending transfers expire after 15 minutes.

The behavior was checked against PurpleFox's public `JudgeTournament.f43106ee.js` and `tournament.7d89f07e.js` application bundles. PurpleFox application changes may require a script update.

`tests/verify_gem_purplefox_copy.cjs` checks the original 98-match Kyoto extraction and clipboard behavior. `tests/verify_gem_purplefox_send.cjs` checks result and pairing transfers with all browser requests intercepted. Pairing checks cover a six-column print fixture built from the real Kyoto names/IDs, print points, report fallback, byes, Unicode, hidden rows, stale print data, and omission of result/status writes. It also checks login, destinations, round/range mismatches, API responses, logs, and partial failures. These tests do not submit live tournament data. Run them with Node.js, Playwright, and Microsoft Edge available.

The JSON extraction schema is adapted from **GEM PurpleFox Extract v1.3.0** by Dan Collins and Aurélie Violette.
