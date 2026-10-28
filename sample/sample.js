"use strict";

/*
  Free SASE Practice Sample.
  Client-side grading is used ONLY because these 10 questions and their
  answer key are already public in the free sample PDF shared by the Page.
  Never put paid reviewer or portal questions in this file.
*/
var QUESTIONS = [
  {
    n: 1, section: "Language Usage",
    question: "The architect was <em>meticulous</em> in checking every detail of the blueprint. Which word is closest in meaning to <em>meticulous</em>?",
    options: { A: "careless", B: "hasty", C: "thorough", D: "lazy" },
    answer: "C",
    explanation: "<em>Meticulous</em> means showing great attention to detail: <strong>thorough</strong>."
  },
  {
    n: 2, section: "Language Usage",
    question: "Because she was <em>frugal</em>, she managed to save enough for college tuition. Which word is closest in meaning to <em>frugal</em>?",
    options: { A: "thrifty", B: "wasteful", C: "generous", D: "lavish" },
    answer: "A",
    explanation: "<em>Frugal</em> means careful with money: <strong>thrifty</strong>."
  },
  {
    n: 3, section: "Language Usage",
    question: "The vote was <em>unanimous</em>, every single member raised a hand in favor. What does <em>unanimous</em> mean here?",
    options: { A: "divided", B: "delayed", C: "in complete agreement", D: "secret" },
    answer: "C",
    explanation: "The context clue (every member in favor) points to <strong>in complete agreement</strong>."
  },
  {
    n: 4, section: "Mathematics",
    question: "8 + 4 × 3 − 6 ÷ 2 = ?",
    options: { A: "33", B: "17", C: "21", D: "14" },
    answer: "B",
    explanation: "Order of operations: 8 + 12 − 3 = <strong>17</strong>."
  },
  {
    n: 5, section: "Mathematics",
    question: "3/8 of 160 = ?",
    options: { A: "48", B: "40", C: "60", D: "24" },
    answer: "C",
    explanation: "3/8 × 160 = 480/8 = <strong>60</strong>."
  },
  {
    n: 6, section: "Aptitude",
    question: "Find the next term: 3, 7, 12, 18, 25, __",
    options: { A: "30", B: "33", C: "31", D: "35" },
    answer: "B",
    explanation: "Differences grow by 1 each time (4, 5, 6, 7, 8): 25 + 8 = <strong>33</strong>."
  },
  {
    n: 7, section: "Aptitude",
    question: "Find the next term: 1, 4, 9, 16, 25, __",
    options: { A: "30", B: "32", C: "36", D: "49" },
    answer: "C",
    explanation: "These are perfect squares (1², 2², 3², 4², 5²), so the next is 6² = <strong>36</strong>."
  },
  {
    n: 8, section: "Science",
    question: "Which organelle is the site of photosynthesis in plant cells?",
    options: { A: "Mitochondrion", B: "Nucleus", C: "Chloroplast", D: "Ribosome" },
    answer: "C",
    explanation: "Photosynthesis happens in the <strong>chloroplast</strong>."
  },
  {
    n: 9, section: "Science",
    question: "During which phase of mitosis do sister chromatids separate and move to opposite poles?",
    options: { A: "Prophase", B: "Anaphase", C: "Telophase", D: "Metaphase" },
    answer: "B",
    explanation: "Chromatids separate during <strong>anaphase</strong>."
  },
  {
    n: 10, section: "Science",
    question: "In pea plants, tall (T) is dominant over short (t). What phenotypic ratio results from a Tt × Tt cross?",
    options: { A: "1:1", B: "1:2:1", C: "9:3:3:1", D: "3:1" },
    answer: "D",
    explanation: "A monohybrid cross gives a <strong>3:1</strong> dominant-to-recessive phenotypic ratio."
  }
];

var SUBJECTS = ["Language Usage", "Mathematics", "Aptitude", "Science"];
var LETTERS = ["A", "B", "C", "D"];

var BANDS = [
  { min: 8, text: "Strong start. You handled most of the sample well. Keep that level across all subjects by practicing with more questions and timed mock exams, so your speed and accuracy hold up over a full 180-item test." },
  { min: 5, text: "Good effort. You already have a base to build on, and your missed items are useful: they show exactly where to focus next. That is what practice is for. Start with the review priority above, then work through the explanations below." },
  { min: 0, text: "Thank you for trying. A low first score is normal, and it is useful, because now you know where to start. Read the explanation for every item below, especially the ones you missed, then keep practicing a little every day. Steady review is what builds real readiness." }
];

var current = 0;
var answers = QUESTIONS.map(function () { return null; });

function el(id) { return document.getElementById(id); }

function showScreen(id) {
  var screens = document.querySelectorAll(".screen");
  screens.forEach(function (s) { s.classList.toggle("active", s.id === id); });
  window.scrollTo(0, 0);
}

function renderQuestion() {
  var q = QUESTIONS[current];
  el("progress-text").textContent = "Question " + (current + 1) + " of " + QUESTIONS.length;
  var pct = Math.round(((current + 1) / QUESTIONS.length) * 100);
  el("progress-fill").style.transform = "scaleX(" + ((current + 1) / QUESTIONS.length) + ")";
  document.querySelector(".progress-track").setAttribute("aria-valuenow", String(pct));
  el("q-section").textContent = q.section;
  el("q-number").textContent = "Question " + q.n;
  el("q-text").innerHTML = q.question;

  var box = el("q-options");
  box.innerHTML = "";
  LETTERS.forEach(function (letter) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "option" + (answers[current] === letter ? " selected" : "");
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", answers[current] === letter ? "true" : "false");
    btn.setAttribute("aria-label", "Choice " + letter + ": " + q.options[letter]);

    var chip = document.createElement("span");
    chip.className = "opt-letter";
    chip.textContent = letter;
    btn.appendChild(chip);

    var text = document.createElement("span");
    text.textContent = q.options[letter];
    btn.appendChild(text);

    btn.addEventListener("click", function () {
      answers[current] = letter;
      renderQuestion();
    });
    box.appendChild(btn);
  });

  var isLast = current === QUESTIONS.length - 1;
  el("prev-btn").disabled = current === 0;
  el("next-btn").hidden = isLast;
  el("submit-btn").hidden = !isLast;
  el("submit-prompt").hidden = !isLast;
  el("skip-warning").hidden = true;
}

function skippedCount() {
  return answers.filter(function (a) { return a === null; }).length;
}

function submit() {
  var skipped = skippedCount();
  if (skipped > 0 && el("skip-warning").hidden) {
    el("skip-warning-text").textContent =
      "You skipped " + skipped + " questions. Skipped questions score zero. Go back if you want to answer them, or submit and see your score.";
    el("skip-warning").hidden = false;
    el("skip-warning").scrollIntoView({ block: "nearest" });
    return;
  }
  renderScore();
  showScreen("screen-score");
  el("score-title").focus();
}

function subjectResults() {
  var results = {};
  SUBJECTS.forEach(function (s) { results[s] = { correct: 0, total: 0 }; });
  QUESTIONS.forEach(function (q, i) {
    results[q.section].total += 1;
    if (answers[i] === q.answer) { results[q.section].correct += 1; }
  });
  return results;
}

function weakestSubjects(results) {
  var missed = SUBJECTS.filter(function (s) { return results[s].correct < results[s].total; });
  if (missed.length === 0) { return []; }
  var worst = Math.min.apply(null, missed.map(function (s) {
    return results[s].correct / results[s].total;
  }));
  return missed.filter(function (s) {
    return results[s].correct / results[s].total === worst;
  });
}

function joinNames(names) {
  if (names.length <= 2) { return names.join(" and "); }
  return names.slice(0, -1).join(", ") + ", and " + names[names.length - 1];
}

function renderScore() {
  var results = subjectResults();
  var score = QUESTIONS.reduce(function (sum, q, i) {
    return sum + (answers[i] === q.answer ? 1 : 0);
  }, 0);

  el("score-line").textContent = "You scored " + score + " out of " + QUESTIONS.length + ".";
  var band = BANDS.find(function (b) { return score >= b.min; });
  el("band-text").textContent = band.text;

  var list = el("breakdown-list");
  list.innerHTML = "";
  SUBJECTS.forEach(function (s) {
    var li = document.createElement("li");
    li.textContent = s + ": " + results[s].correct + " of " + results[s].total;
    list.appendChild(li);
  });

  var weakest = weakestSubjects(results);
  if (weakest.length === 0) {
    el("review-priority").textContent =
      "Review first: no single weak subject in this sample. You answered every item correctly, so keep your level up with timed full-length practice.";
  } else {
    el("review-priority").textContent =
      "Review first: " + joinNames(weakest) + ". Your missed items there will teach you the most per hour of study.";
  }

  var review = el("review-list");
  review.innerHTML = "";
  QUESTIONS.forEach(function (q, i) {
    var item = document.createElement("div");
    item.className = "sample-review-item";

    var head = document.createElement("p");
    head.className = "sample-review-q";
    var num = document.createElement("span");
    num.textContent = q.n + ". ";
    head.appendChild(num);
    var qspan = document.createElement("span");
    qspan.innerHTML = q.question;
    head.appendChild(qspan);
    item.appendChild(head);

    var yours = answers[i];
    var line = document.createElement("p");
    line.className = "sample-review-line " + (yours === q.answer ? "is-correct" : "is-wrong");
    line.textContent =
      "Your answer: " + (yours === null ? "none" : yours) +
      ". Correct answer: " + q.answer + ". ";
    item.appendChild(line);

    var expl = document.createElement("p");
    expl.className = "sample-review-expl";
    expl.innerHTML = q.explanation;
    item.appendChild(expl);

    review.appendChild(item);
  });
}

function reset() {
  current = 0;
  answers = QUESTIONS.map(function () { return null; });
  renderQuestion();
  showScreen("screen-intro");
}

el("start-btn").addEventListener("click", function () {
  current = 0;
  renderQuestion();
  showScreen("screen-quiz");
});
el("prev-btn").addEventListener("click", function () {
  if (current > 0) { current -= 1; renderQuestion(); }
});
el("next-btn").addEventListener("click", function () {
  if (current < QUESTIONS.length - 1) { current += 1; renderQuestion(); }
});
el("submit-btn").addEventListener("click", submit);
el("skip-submit-btn").addEventListener("click", submit);
el("skip-back-btn").addEventListener("click", function () {
  el("skip-warning").hidden = true;
  var firstSkipped = answers.indexOf(null);
  if (firstSkipped >= 0) { current = firstSkipped; renderQuestion(); }
});
el("retake-btn").addEventListener("click", reset);

renderQuestion();
