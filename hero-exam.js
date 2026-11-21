"use strict";
/*
  Hero sample exam engine (GT-20261121-08).
  Client-side grading is used ONLY because these 10 questions and their
  answer keys are already public: the SASE set is the free sample shared
  by the Page (same data as sample/sample.js), and the CSE set is the
  public CSE free sample. Never put paid reviewer or portal questions
  in this file or in the per-page HERO_EXAM data.
  Behavior: one item at a time, tap an answer for immediate correct or
  wrong feedback with the explanation, a Bubble Rail of 10 bubbles that
  fills per answer, a running score, and a completion readout with the
  per-topic filled counts and the weakest topic named first. The same
  readout is mirrored into the page readout band (#readout-live).
*/
(function () {
  var cfg = window.HERO_EXAM;
  var card = document.getElementById("heroExam");
  if (!cfg || !card) return;
  var items = cfg.items, subjects = cfg.subjects, LETTERS = ["A", "B", "C", "D"];
  var rail = card.querySelector(".hx-rail");
  var progEl = card.querySelector(".hx-progress");
  var scoreEl = card.querySelector(".hx-score");
  var body = card.querySelector(".hx-body");
  var current = 0, answers = items.map(function () { return null; }), locked = false;

  function esc(s) { return String(s); }
  function topicCounts() {
    var counts = {};
    subjects.forEach(function (s) { counts[s] = { total: 0, correct: 0 }; });
    items.forEach(function (q, i) {
      counts[q.section].total += 1;
      if (answers[i] === q.answer) counts[q.section].correct += 1;
    });
    return counts;
  }
  function weakestFirst(counts) {
    return subjects.slice().sort(function (a, b) {
      var ra = counts[a].correct / counts[a].total, rb = counts[b].correct / counts[b].total;
      return ra - rb;
    });
  }
  function renderRail() {
    rail.innerHTML = "";
    items.forEach(function (_, i) {
      var b = document.createElement("span");
      b.className = "hx-bubble" + (answers[i] !== null ? " filled" : "") + (i === current && answers.every(function (a, j) { return j >= i || a !== null; }) && answers[i] === null ? " current" : "");
      b.textContent = String(i + 1);
      rail.appendChild(b);
    });
  }
  function renderHeader() {
    var done = answers.filter(function (a) { return a !== null; }).length;
    var score = items.reduce(function (s, q, i) { return s + (answers[i] === q.answer ? 1 : 0); }, 0);
    progEl.textContent = done === items.length ? "Sample complete" : "Question " + (current + 1) + " of " + items.length;
    scoreEl.textContent = "Score " + score + " of " + done + " answered";
    renderRail();
  }
  function renderQuestion() {
    locked = false;
    var q = items[current];
    renderHeader();
    body.innerHTML = "";
    var sec = document.createElement("p"); sec.className = "hx-section"; sec.textContent = q.section;
    var qt = document.createElement("p"); qt.className = "hx-question"; qt.innerHTML = esc(q.question);
    body.appendChild(sec); body.appendChild(qt);
    var opts = document.createElement("div"); opts.className = "hx-options"; opts.setAttribute("role", "radiogroup");
    LETTERS.forEach(function (letter) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "hx-opt"; b.setAttribute("role", "radio"); b.setAttribute("aria-checked", "false");
      var chip = document.createElement("span"); chip.className = "hx-chip"; chip.textContent = letter;
      b.appendChild(chip); b.appendChild(document.createTextNode(" " + q.options[letter]));
      b.addEventListener("click", function () { answer(letter, b, opts); });
      opts.appendChild(b);
    });
    body.appendChild(opts);
    var fb = document.createElement("div"); fb.className = "hx-feedback"; fb.hidden = true; body.appendChild(fb);
  }
  function answer(letter, btn, opts) {
    if (locked) return; locked = true;
    var q = items[current];
    answers[current] = letter;
    var correct = letter === q.answer;
    opts.querySelectorAll(".hx-opt").forEach(function (o, i) {
      var l = LETTERS[i];
      o.disabled = true;
      if (l === q.answer) o.classList.add("correct");
      if (l === letter && !correct) o.classList.add("wrong");
      if (l === letter) o.setAttribute("aria-checked", "true");
    });
    renderHeader();
    var fb = body.querySelector(".hx-feedback");
    fb.hidden = false;
    fb.className = "hx-feedback " + (correct ? "is-correct" : "is-wrong");
    var head = document.createElement("p"); head.className = "hx-fb-head";
    head.textContent = correct ? "Correct." : "Not quite. The correct answer is " + q.answer + ".";
    var ex = document.createElement("p"); ex.className = "hx-fb-text"; ex.innerHTML = esc(q.explanation);
    fb.appendChild(head); fb.appendChild(ex);
    var next = document.createElement("button");
    next.type = "button"; next.className = "btn hx-next";
    next.textContent = current === items.length - 1 ? "See my readout" : "Next question";
    next.addEventListener("click", function () {
      if (current === items.length - 1) renderResult(); else { current += 1; renderQuestion(); }
    });
    fb.appendChild(next);
    next.focus({ preventScroll: false });
  }
  function topicRows(counts, order) {
    var wrap = document.createElement("div"); wrap.className = "hx-topics";
    order.forEach(function (s) {
      var row = document.createElement("div"); row.className = "hx-topic";
      var name = document.createElement("span"); name.className = "hx-topic-name"; name.textContent = s;
      var track = document.createElement("span"); track.className = "hx-topic-track";
      var fill = document.createElement("span"); fill.className = "hx-topic-fill" + (counts[s].correct < counts[s].total ? " weak" : "");
      fill.style.transform = "scaleX(" + (counts[s].correct / counts[s].total) + ")";
      track.appendChild(fill);
      var num = document.createElement("span"); num.className = "hx-topic-num";
      num.textContent = counts[s].correct + " of " + counts[s].total + " filled";
      row.appendChild(name); row.appendChild(track); row.appendChild(num);
      wrap.appendChild(row);
    });
    return wrap;
  }
  function renderResult() {
    renderHeader();
    var score = items.reduce(function (s, q, i) { return s + (answers[i] === q.answer ? 1 : 0); }, 0);
    var counts = topicCounts(), order = weakestFirst(counts), weakest = order[0];
    body.innerHTML = "";
    var line = document.createElement("p"); line.className = "hx-score-line";
    line.textContent = score + " of " + items.length;
    var pct = document.createElement("p"); pct.className = "hx-score-pct";
    pct.textContent = Math.round((score / items.length) * 100) + "% on the free sample";
    body.appendChild(line); body.appendChild(pct);
    body.appendChild(topicRows(counts, order));
    var weak = document.createElement("p"); weak.className = "hx-weak";
    weak.textContent = counts[weakest].correct === counts[weakest].total
      ? "No weak topic in this sample. Every topic came back fully filled, so the next step is timed full-length practice."
      : "Weakest topic: " + weakest + ". This topic is where points are lost, and it is exactly what the full reviewer trains next, with lessons and explained questions on every topic.";
    body.appendChild(weak);
    var actions = document.createElement("div"); actions.className = "hx-actions";
    var get = document.createElement("a"); get.className = "btn"; get.href = "#order"; get.textContent = cfg.orderLabel;
    var again = document.createElement("button"); again.type = "button"; again.className = "btn-outline"; again.textContent = "Retake the sample";
    again.addEventListener("click", function () {
      answers = items.map(function () { return null; }); current = 0; renderQuestion(); mirrorReadout(null);
    });
    actions.appendChild(get); actions.appendChild(again);
    if (cfg.sampleHref) {
      var full = document.createElement("a"); full.className = "text-link"; full.href = cfg.sampleHref;
      if (cfg.sampleExternal) { full.target = "_blank"; full.rel = "noopener"; }
      full.textContent = cfg.sampleLabel;
      actions.appendChild(full);
    }
    body.appendChild(actions);
    mirrorReadout({ score: score, counts: counts, order: order, weakest: weakest });
  }
  function mirrorReadout(result) {
    var live = document.getElementById("readout-live");
    if (!live) return;
    live.innerHTML = "";
    if (!result) {
      var p = document.createElement("p"); p.className = "rb-note";
      p.textContent = "Answer the 10 sample items in the hero and your own readout prints here: your score, your filled bubbles per topic, and the topic to train first.";
      live.appendChild(p); return;
    }
    var big = document.createElement("p"); big.className = "rb-score";
    big.textContent = result.score + " of " + items.length;
    live.appendChild(big);
    live.appendChild(topicRows(result.counts, result.order));
    var w = document.createElement("p"); w.className = "rb-weak";
    w.textContent = "Start with " + result.weakest + ". The full reviewer trains it with lessons first, then explained questions, then timed mock exams.";
    live.appendChild(w);
  }
  renderQuestion();
})();
