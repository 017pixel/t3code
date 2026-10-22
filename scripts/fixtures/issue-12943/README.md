Stop the isolated dev server, then seed an existing empty thread:

```sh
python3 scripts/fixtures/issue-12943/seed.py .t3/userdata/statev2.sqlite '<thread-id>'
```

Restart `vp run dev` and pair a fresh browser profile so cached history does not hide
the fixture. The thread contains 120 alternating user/assistant messages. Load earlier
turns if needed, select across messages while holding the primary mouse button, and
scroll beyond the list buffer in both directions. Check that the highlight and copied
text remain continuous. Repeat immediately after scrolling, before the list's idle DOM
sort can run. Clear the selection and check that off-screen rows recycle again.
