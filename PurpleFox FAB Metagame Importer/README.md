# PurpleFox Metagame Import

1. In Tampermonkey, choose **Create a new script**, replace the editor contents with `PurpleFox Metagame Import.user.js`, and save.
2. Refresh https://eor-us.purple-fox.fr/stage/tools?tab=metagame.
3. Click **Import metagame** at the bottom right. The supplied data is prefilled.
4. Check the preview: **96 players across 28 heroes**. Click **Apply counts**, then **Close**.
5. Use PurpleFox's normal **Export** or **Copy as text** button.

For later events, paste the original player JSON, load a JSON file, or paste two tab-separated columns: Hero and Count. Counted JSON rows use `{"hero":"Ira, Crimson Haze","count":18}`. Player JSON rows each contribute one player. The helper removes the trailing `(LL)` annotation when matching names, and uses PurpleFox's current hero list. Unknown or ambiguous names stop the import before changing the chart.

Applying replaces the existing local chart and displays counts with Use Percent unchecked. **Undo last import** restores the previous chart and percentage setting until the page is reloaded. The helper updates the page's local metagame component; it does not write to tournament records. PurpleFox's page component does not persist this chart across reloads.

Compatibility was checked against PurpleFox's public Stage Tools component and hero list on 2026-10-18. All 96 records were verified against the current hero list, including distinct young and adult versions. Parsing, validation, component discovery, state updates, and rollback were tested locally. The helper has not been executed in the signed-in browser page. Because it accesses Vue's component state, a future PurpleFox update may require a helper update.
