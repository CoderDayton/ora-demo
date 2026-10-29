# Observed behavior

Measured against `lfm3-omni/LFM3-Omni-2B-Q8_0.gguf` (with its BF16 mmproj, 16384 context, 2 slots, reasoning off) through a recording proxy between Ora and llama-server, so every request and reply below is the real wire traffic. Tools enabled: `docs`, `utility`, `web` (SearXNG). One machine, one GPU, one run per cell unless a count says otherwise. Numbers are medians in milliseconds.

| Phase | What | Runs |
| --- | --- | --- |
| A | Single text turns, 107 prompts x auto off/on x 2 repeats | 428 |
| B | Multi-turn chats (geography, arithmetic, topic switch, correction, web, voice fragments), auto off/on | 240 |
| C | Speech recognition: TTS to ASR, clean and degraded audio | 736 |
| D | Image and video-as-frames turns | 114 |
| E | Speech in, then turn, then speech out, then ASR back | 376 |

Roughly 1,900 turns plus about 2,900 llama requests were recorded. Pure latency figures are from a shared GPU and move with other load.

## What Ora sends

| Call | Slot | Shape |
| --- | --- | --- |
| Chat turn | 0 | `POST /v1/chat/completions`, `stream: true`, `cache_prompt: true`, `stream_options.include_usage`, `temperature` and `max_tokens` from the page (auto may change them), `tools` for the enabled groups |
| Planner (auto only) | 1 | Non-streaming, `temperature: 0`, `max_tokens: 140`, one system message (about 970 chars) and one user message: `Documents attached`, `Earlier turns, newest first`, `Question` |
| ASR | 1 | Non-streaming, `temperature: 0`, `max_tokens` from the clip length (42 for a short one), system message plus one `input_audio` part (WAV, base64) |
| TTS | n/a | `POST /tts` with `{input, voice}` only |

Tool names seen: `current_time`, `calculate`, `search_documents`, `read_document`, `web_search`, `web_fetch`.

A turn's messages are `system`, the history, then the new `user` message. Saved tool steps are replayed as an assistant message with `tool_calls` plus `tool` messages. Images are sent on the turn that attached them only: a follow-up about an image has a prompt of about 150 tokens against about 600 with the image, and the model answers from its own earlier text.

## Text turns (phase A)

Correct answers are graded on facts, arithmetic and code (fact 97%, math 100%, calc 100% in both modes). One "wrong" fact is a grader miss (`Brasília` vs `Brasilia`). One code answer in auto mode missed the grader pattern.

| Kind | Tool use | Median total, auto off | Median total, auto on |
| --- | --- | --- | --- |
| fact (capital, symbol, author) | web search on every one | 338 | 521 |
| math ("what is 59 times 67") | `calculate` on every one | 145 | 295 |
| calc ("calculate ...") | `calculate` | 157 | 275 |
| time | `current_time` | 149 | 335 |
| web (prices, news, population) | `web_search`, sometimes `web_fetch` | 1398 | 1026 |
| chat ("hello", "thanks", "ok") | none (20% use a tool) | 81 | 266 |
| creative | search in 40% (off) and 80% (auto) | 227 | 955 |
| system ("list my files") | none; the model says it cannot | 248 | 259 |

- The planner adds a median of 163 ms and 1 extra request per turn. It returned `maxTokens` and `pageShare` every time, `temperature` in 28 of 214, `tools` in 2 of 214 (always empty), and never `memory` (0 of 214).
- Auto mode changes the reply text in 79 of 214 pairs. Repeating the same prompt gives a different reply in 18 of 214 pairs, so some of that is sampling.
- The model web-searches trivial facts it knows ("capital of Japan"), which costs 300 to 1400 ms. It also searches for creative writing and for "I am bored".
- Raw tool markup leaks into the reply as text (`<tool_call><function=read_document>...`) for the weather and news prompts and for "Who wrote Moby Dick?" in 10 of 428 runs: the model called a tool in text form instead of through the tool channel.
- The `system` group is never enabled here, so file and command requests are refused in prose. One reply claimed a file "has been created" without any tool run.
- Live web answers are plausible but unchecked: the Bitcoin price changed between two runs a minute apart ($80,071 and $81,101) and the exchange-rate answer quoted 1.11371.

## Multi-turn chats (phase B)

| Scenario | Result (auto off / auto on) |
| --- | --- |
| Follow-up with a pronoun ("and Italy?", "add 100 to that") | 16/16 and 16/16 on arithmetic; geography 11/12 and 10/12 |
| Topic switch and return | 8/8 and 8/8 |
| Voice fragments ("What's the...", then "capital of France") | 8/8 and 8/8 at the model; the page joins them before sending, so the server saw them as separate messages here |
| User corrects the model wrongly ("No, it's Sydney") | model gives in: 4 of 12 final answers still said Sydney in each mode |
| Identity boilerplate ("I'm LFM...") on follow-ups | 0 occurrences in 240 turns |

- The repeat guard fired 8 times, all in auto mode except once, and each retry produced a normal reply. Its note ("the model started repeating an earlier reply...") reaches the page.
- Prompt size grows per turn (median 861, 1213, 1552, 1636, 1710 tokens at turns 1 to 5), and `cache_n` shows the earlier turns reused.
- One chat ran a tool loop: a 5-turn chat reached 42 messages in a single turn (repeated `web_search`), ended with leaked tool markup as the reply, and two turns later the context-full note fired ("27 oldest message(s) left out"). Rounds per turn reached 18 in phase A.
- Asked "What was the second country I asked about?" after a context trim, the reply named the first country: trimming loses the thread when a tool loop eats the window.

## Speech recognition (phase C)

Phrases are synthesized by the model's own TTS and fed back, so these are best-case, single-voice conditions.

| Audio | Word error rate | Exact transcripts | Notes |
| --- | --- | --- | --- |
| Clean, all phrases | 0.21 | 64% | Dominated by numbers |
| Clean, no arithmetic (224) | 0.03 | 96% | Misses: "1984" heard as "94" or "1994"; "ok" heard as "Oak", "arc", "Ark" |
| Clean, `English` hint vs auto | 0.17 / 0.16 vs 0.25 / 0.27 | 66% / 67% vs 63% / 62% | The hint helps; auto more often writes numbers as words |
| Noise at 10 dB and 0 dB | 0.15 and 0.17 | 65% and 63% | Same as clean |
| Very quiet (4% gain) | 0.16 | 68% | Same as clean |
| One second of leading silence | 0.16 | 68% | Same as clean |
| Cut at 60% / 35% of the audio | 0.35 / 0.59 | 0% | 6 and 21 of 40 end on a dangling word, which the page holds back |
| Sample rate divided by 3 | 0.54 | 13% | "capital of the country" invented |
| 2 s of silence | 0.99 | 0% | Always "And": flagged as noise (40/40) |
| 2 s of white noise | 1.00 | 0% | Always "Thank you.": not flagged as noise, 40/40 |

- ASR latency is 40 to 110 ms per utterance; TTS is 110 to 280 ms for a short sentence.
- Numbers are the weak spot: "91 times 21" came back as "9th power times 1 10", "99 times 121", "ninety-nine times one twenty-one".
- The noise filter dropped 3 of 376 clean phrases ("Calculate.", "Oak?", "Ark.").
- The ASR token ceiling scales with the clip (6 per second plus 24, at least 32) and cut nothing up to 34 spoken words (13 s). Longer inputs could not be made here because the TTS stops near 13 s.

## Speech in, turn, speech out (phase E)

376 round trips (94 phrases, male and female, auto off and on).

| Stage | Median |
| --- | --- |
| TTS of the question | 110 to 280 |
| ASR | 53 to 75 |
| Turn to first token (fact / math / chat / web) | 660 / 150 / 60 / 800 off; 680 / 310 / 220 / 1440 on |
| TTS of the reply (2.7 to 8.6 s of speech) | 233 to 658 |

- Exactly heard questions were answered correctly 173 of 173 times; misheard ones 0 of 114. Every wrong answer traces to the transcript, not the model: "Who wrote 1994?" gave "Jack Miller", "12 times doll" got a refusal, "14 times 7 sen" gave 0.98.
- Heard exactly: facts 99 to 100%, chat 95 to 100%, time and web 100%, arithmetic 25 to 37%, "calculate" phrasing 0 to 6%.
- Male and female voices were heard equally well (127/187 and 131/186 exact).
- Reply speech came back through ASR with 79% of the first 20 words recovered, so synthesized replies are intelligible but not perfect.
- 373 of 373 replies were spoken. No errors, no guard notes.
- A synthesized voice differs between requests with the same `voice` value (measured separately: 92 to 160 Hz for `male`). Ora sends the same value every time, so the difference is the model.

## Images and video (phase D)

| Input | Result |
| --- | --- |
| Solid colors (red, blue) | 6/6 each |
| Text in image ("HELLO", "42", invoice total "249", due date "May 5") | 6/6 each, prompt about 600 tokens |
| Count of three circles | 6/6 |
| Shape and color (green triangle) | 6/6 |
| Two images, "colors in order" | 6/6 ("Red, Blue") |
| Image with no text | works; the model describes it |
| Follow-up text turn about the earlier image | answers from its own previous reply; the image is not resent |
| Video as 4 or 8 frames: red then blue | 12/12 |
| Video: counter frames | 8 frames: numbers in order, 6/6. 4 frames: "0, 2, 4, 6" (every other frame; the model is right about what it saw) |
| Video: test pattern | recognized as a color-bar test pattern, 12/12 by eye |
| 9 images | the server keeps 8; the model replied "You sent 10 images" 6/6 |

- Ora has no video input. A video is frames sent as images; the "video" badge reports what the model supports. About 90 tokens per frame at this size: 4 frames cost 380 tokens and 8 cost 710.
- Auto mode made no difference to image answers (36/39 each; the three misses are grader limits on the unscored test pattern).

## Problems found

1. Raw `<tool_call>` markup is shown as the reply when the model emits a tool call as text (10 of 428). Not handled.
2. Tool loops can run to 18 rounds and fill the window; nothing caps rounds per turn.
3. The planner almost never returns `tools` (2 of 214, empty) or `memory` (0 of 214) with this model, so auto mode in practice tunes reply length and page share.
4. White noise is transcribed as "Thank you." and passes the noise filter.
5. The model web-searches known facts and creative prompts, adding 300 to 1400 ms.
6. The model accepts a wrong correction from the user ("it's Sydney") about one third of the time.
7. Numbers in speech are mistranscribed often enough to make spoken arithmetic unreliable.
8. A server that closes a kept-alive connection between rounds makes the second request fail with `socket hang up` and no retry (found when a test proxy closed idle sockets; llama-server itself does not).

## Fixes

| # | Problem | Fix |
| --- | --- | --- |
| 1 | Tool call written as text shows up as the reply | The reply is held while it starts with `<tool_call>`; at the end the markup is parsed into a real tool call and run. In the round without tools (where the model writes the markup because it wants one more search) the markup is dropped and the model is told to answer in words. **Measured: leaks went from 18 of 24 to 0 of 24.** |
| 2 | Tool loops run to 18 rounds | A call identical to one already run in the turn is not run again: the model is told it already has that result, and after two such repeats the next round has no tools, so it must answer. The round caps stay. Covered by tests; the slowest of the 24 live turns above took 6.1 s. |
| 3 | Planner returns almost no `tools` or `memory` | The planner now answers with words (`tone`, `length`, `pages`, `speed`, `wait`, `memory` of `all`, `recent` or `new`); numbers are still accepted, and the parser takes what the model really writes (`"tools": "web"` as a string, `"precise for facts, maths and code"` as a word with an explanation). **Measured: every plan now carries a tone and tools; `memory` is `all` (no trim) each time. Quality is poor:** it picks `web` for every question and a 0.2 temperature for a haiku. Auto mode's tool and memory choices are not yet worth trusting with this model. |
| 4 | White noise transcribed as "Thank you." | Not fixed. "Thank you." is a real, common reply, so dropping it would lose real speech; the page's level detector only records when the level rises above the room floor. |
| 5 | Model searches the web for facts it knows | Every chat now carries a short rule: answer from knowledge when sure, use tools for current or changing information, arithmetic and documents. The `web_search` description says the same. **Measured: no effect.** 34 of 34 facts still triggered a search in both modes (correct 34 of 34). The 2B model follows the presence of a tool, not the rule; the rule stays because it costs nothing, but a real fix needs a different design (answer first, search only on request) and was not made. |
| 6 | Model gives in to a wrong correction | The same rule tells it to keep a fact it is sure of when the user disputes it, politely. **Measured: caving fell from 4 of 12 to 2 of 12 in each mode** (12 chats per mode, six countries, two repeats; a small sample). |
| 7 | Spoken numbers mistranscribed | Not fixed. Three instructions were tried directly against the model on 74 spoken phrases (the current one, "write numbers as digits", and the same with an example): exact transcripts 26, 27 and 29 of 74, which is noise. The errors are acoustic ("forty" heard as "4t"), so the prompt cannot fix them. These are the model's own synthetic voices; real speech may do better, unmeasured. |
| 8 | Dropped kept-alive connection fails the call | A request that fails before any reply arrives is sent once more, never more than once. Covered by tests with a server that drops the first connection. |

The measurements above were taken before these fixes.
