document.addEventListener("DOMContentLoaded", () => {

    // ================================================================
    // 1. CONFIG
    // ================================================================
    const API_BASE = "https://opentdb.com/api.php";
    const TRIVIA_CATEGORY_ID = 18;

    const TIMEOUT_ANSWER = -1;   // timer ran out before user answered
    const SKIP_ANSWER    = -2;   // user manually clicked Next without answering

    const VALID_PANELS = new Set(["setup", "loading", "quiz", "results"]);

    const topics = [
        { tag: "html",       label: "HTML",       icon: "📄" },
        { tag: "css",        label: "CSS",        icon: "🎨" },
        { tag: "javascript", label: "JavaScript", icon: "📜" },
        { tag: "dom",        label: "DOM",        icon: "🌳" },
        { tag: "jquery",     label: "jQuery",     icon: "🔗" },
        { tag: "bootstrap",  label: "Bootstrap",  icon: "🅱️" }
    ];

    const topicKeywords = {
        html:       ["html", "markup", "<div>", "<a>", "tag"],
        css:        ["css", "stylesheet", "flexbox", "selector", " style "],
        javascript: ["javascript", "ecmascript", " js ", "function", "variable", "array", "node.js"],
        dom:        ["dom", "document object model", "document.", "event listener"],
        jquery:     ["jquery", "$("],
        bootstrap:  ["bootstrap"]
    };

    const POLLINATIONS_TEXT_API = "https://text.pollinations.ai/openai";

    // ================================================================
    // 2. DOM ELEMENT REFERENCES
    // ================================================================
    const quizContainer    = document.getElementById("quiz-container");
    const progressWrap     = document.getElementById("progress-wrap");

    const setupPanel       = document.getElementById("setup-panel");
    const topicGrid        = document.getElementById("topic-grid");
    const difficultySelect = document.getElementById("difficulty-select");
    const countSelect      = document.getElementById("count-select");
    const setupError       = document.getElementById("setup-error");
    const startQuizBtn     = document.getElementById("start-quiz-btn");

    const loadingPanel     = document.getElementById("loading-panel");

    const quizPanel        = document.getElementById("quiz-panel");
    const questionCounter  = document.getElementById("question-counter");
    const timerDisplay     = document.getElementById("timer-display");
    const questionText     = document.getElementById("question-text");
    const optionsContainer = document.getElementById("options-container");
    const nextBtn          = document.getElementById("next-btn");
    const quitBtn          = document.getElementById("quit-btn");
    const progressBar      = document.getElementById("progress-bar");

    const resultsPanel     = document.getElementById("results-panel");
    const scorePercent     = document.getElementById("score-percent");
    const scoreText        = document.getElementById("score-text");
    const scoreBreakdown   = document.getElementById("score-breakdown");
    const resultEmoji      = document.getElementById("result-emoji");
    const retryBtn         = document.getElementById("retry-btn");
    const newTopicBtn      = document.getElementById("new-topic-btn");

    // ================================================================
    // 3. STATE VARIABLES
    // ================================================================
    let questions            = [];
    let selectedTopic        = null;
    let currentQuestionIndex = 0;
    let userScore            = 0;
    let userAnswers          = [];
    let timerInterval;
    let timeLeft             = 10;
    let autoAdvanceTimeout;
    let isAdvancing          = false;
    let hasAnswered          = false;   // tracks whether the current question was answered

    // ================================================================
    // 4. PANEL SWITCHING HELPER
    // ================================================================
    function showPanel(name) {
        if (!VALID_PANELS.has(name)) {
            console.error(`showPanel: unknown panel "${name}". Valid options: ${[...VALID_PANELS].join(", ")}`);
            return;
        }
        setupPanel.style.display   = name === "setup"   ? "block" : "none";
        loadingPanel.style.display = name === "loading" ? "block" : "none";
        quizPanel.style.display    = name === "quiz"    ? "block" : "none";
        resultsPanel.style.display = name === "results" ? "block" : "none";

        progressWrap.style.display = (name === "quiz" || name === "results") ? "block" : "none";
    }

    // ================================================================
    // 5. SETUP PANEL — topic cards
    // ================================================================
    function renderTopicCards() {
        topicGrid.innerHTML = "";
        topics.forEach(topic => {
            const col = document.createElement("div");
            col.className = "col-6 col-sm-4";

            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "btn btn-outline-secondary w-100 py-3";
            btn.dataset.tag = topic.tag;
            btn.innerHTML = `<div style="font-size:1.5rem;" class="mb-1">${topic.icon}</div><div class="small fw-medium">${topic.label}</div>`;

            btn.addEventListener("click", () => {
                selectedTopic = topic.tag;
                topicGrid.querySelectorAll("button").forEach(b => {
                    b.classList.remove("btn-primary", "active");
                    b.classList.add("btn-outline-secondary");
                });
                btn.classList.remove("btn-outline-secondary");
                btn.classList.add("btn-primary", "active");
                updateStartButtonState();
            });

            col.appendChild(btn);
            topicGrid.appendChild(col);
        });
    }

    function updateStartButtonState() {
        startQuizBtn.disabled = !selectedTopic;
    }

    // ================================================================
    // 6. HTML ENTITY DECODING
    // ================================================================
    function decodeHTMLEntities(text) {
        const txt = document.createElement("textarea");
        txt.innerHTML = text;
        return txt.value;
    }

    // ================================================================
    // 7. FETCH QUESTIONS
    // ================================================================
    async function requestTrivia(amount, difficulty) {
        const params = new URLSearchParams({
            amount: String(amount),
            category: String(TRIVIA_CATEGORY_ID),
            type: "multiple"
        });
        if (difficulty) params.set("difficulty", difficulty);

        const response = await fetch(`${API_BASE}?${params.toString()}`);

        if (response.status === 429) {
            throw new Error("Open Trivia DB is rate-limiting requests (it only allows 1 request every 5 seconds) — please wait a few seconds and try again.");
        }
        if (!response.ok) {
            throw new Error(`Open Trivia DB request failed (status ${response.status}).`);
        }
        return response.json();
    }

    async function fetchRawQuestions(difficulty, poolSize) {
        const data = await requestTrivia(poolSize, difficulty);

        if (data.response_code === 1) {
            throw new Error("Not enough questions available for that difficulty — try 'Any' difficulty or fewer questions.");
        }
        if (data.response_code !== 0 || !data.results || data.results.length === 0) {
            throw new Error("No questions came back for that combination — try a different difficulty.");
        }

        return data.results.map(decodeApiQuestion);
    }

    function filterByTopic(decoded, tag, limit) {
        const keywords  = topicKeywords[tag] || [];
        const matched   = decoded.filter(q => keywords.some(k => q.question.toLowerCase().includes(k)));
        const unmatched = decoded.filter(q => !matched.includes(q));
        return [...matched, ...unmatched].slice(0, limit);
    }

    function transformQuestions(decodedList) {
        return decodedList.map(decodedQuestion => {
            const options = [...decodedQuestion.incorrect_answers, decodedQuestion.correct_answer];

            for (let i = options.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [options[i], options[j]] = [options[j], options[i]];
            }

            const answerIndex = options.indexOf(decodedQuestion.correct_answer);

            return {
                question: decodedQuestion.question,
                options,
                answer: answerIndex
            };
        });
    }

    async function fetchQuestions(tag, difficulty, limit) {
        const numLimit = parseInt(limit, 10);
        const poolSize = Math.min(50, Math.max(numLimit, 30));

        const decoded  = await fetchRawQuestions(difficulty, poolSize);
        const filtered = filterByTopic(decoded, tag, numLimit);

        if (filtered.length === 0) {
            throw new Error("No questions came back for that combination — try a different difficulty.");
        }

        return transformQuestions(filtered);
    }

    function decodeApiQuestion(apiQuestion) {
        return {
            question: decodeHTMLEntities(apiQuestion.question),
            correct_answer: decodeHTMLEntities(apiQuestion.correct_answer),
            incorrect_answers: apiQuestion.incorrect_answers.map(decodeHTMLEntities)
        };
    }

    // ================================================================
    // 7b. FETCH EXPLANATIONS — with retry support
    // ================================================================
    async function fetchAllExplanations(questionList, attempt = 1) {
        try {
            const numbered = questionList
                .map((q, i) => `${i + 1}. Question: ${q.question}\nCorrect answer: ${q.answer}`)
                .join("\n\n");

            const payload = {
                model: "openai",
                messages: [
                    {
                        role: "system",
                        content: "You are a concise quiz tutor. You will be given a numbered list of multiple-choice questions with their correct answers. For each one, write exactly one short sentence (max 25 words) explaining why that answer is correct. Respond with ONLY a JSON array of strings, in the same order as the questions — no markdown, no code fences, no extra commentary, and no numbering inside the strings themselves."
                    },
                    {
                        role: "user",
                        content: numbered
                    }
                ],
                temperature: 0.3,
                max_tokens: 1200
            };

            const response = await fetch(POLLINATIONS_TEXT_API, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                if (attempt === 1) return fetchAllExplanations(questionList, 2);
                return null;
            }

            const data    = await response.json();
            const rawText = data?.choices?.[0]?.message?.content;
            if (!rawText) return null;

            const cleaned = rawText.replace(/```json|```/g, "").trim();
            const parsed  = JSON.parse(cleaned);
            return Array.isArray(parsed) ? parsed : null;

        } catch (err) {
            if (attempt === 1) return fetchAllExplanations(questionList, 2);
            return null;
        }
    }

    // ================================================================
    // 8. startQuiz() — shared helper
    // ================================================================
    async function startQuiz() {
        setupError.style.display = "none";
        showPanel("loading");

        try {
            questions = await fetchQuestions(selectedTopic, difficultySelect.value, countSelect.value);
            initialQuiz();
        } catch (err) {
            setupError.textContent   = err.message || "Something went wrong fetching questions.";
            setupError.style.display = "block";
            showPanel("setup");
        }
    }

    startQuizBtn.addEventListener("click", startQuiz);

    retryBtn.addEventListener("click", startQuiz);

    quitBtn.addEventListener("click", () => {
        clearInterval(timerInterval);
        clearTimeout(autoAdvanceTimeout);
        showPanel("setup");
    });

    newTopicBtn.addEventListener("click", () => {
        selectedTopic = null;
        topicGrid.querySelectorAll("button").forEach(b => {
            b.classList.remove("btn-primary", "active");
            b.classList.add("btn-outline-secondary");
        });
        updateStartButtonState();
        showPanel("setup");
    });

    // ================================================================
    // 9. initialQuiz()
    // ================================================================
    function initialQuiz() {
        currentQuestionIndex = 0;
        userScore            = 0;
        userAnswers          = [];
        timeLeft             = 10;
        isAdvancing          = false;
        hasAnswered          = false;

        showPanel("quiz");
        loadQuestion();
    }

    // ================================================================
    // 10. loadQuestion()
    // Next button is always visible so users can skip at any time.
    // ================================================================
    function loadQuestion() {
        clearTimeout(autoAdvanceTimeout);
        isAdvancing = false;
        hasAnswered = false;

        // Always show the Next button — label changes based on position
        nextBtn.classList.remove("d-none");
        const isLast = currentQuestionIndex === questions.length - 1;
        nextBtn.textContent = isLast ? "See Results" : "Next Question";

        const currentQuestion = questions[currentQuestionIndex];
        const questionNumber  = currentQuestionIndex + 1;

        questionCounter.textContent = `Question ${questionNumber} of ${questions.length}`;
        progressBar.style.width     = `${(currentQuestionIndex / questions.length) * 100}%`;

        questionText.textContent = `${questionNumber}. ${currentQuestion.question}`;

        optionsContainer.innerHTML = "";
        currentQuestion.options.forEach((option, indx) => {
            const btn = document.createElement("button");
            btn.textContent = option;
            btn.className   = "btn btn-outline-secondary text-start w-100";
            btn.addEventListener("click", () => handleSelection(indx));
            optionsContainer.appendChild(btn);
        });

        resetTimer();
    }

    // ================================================================
    // 11. handleSelection(selectedIndex)
    // Handles both explicit answer picks and TIMEOUT/SKIP sentinel values.
    // ================================================================
    function handleSelection(selectedIndex) {
        // Prevent double-recording if already answered (e.g. timer fires
        // right as user clicks, or user double-clicks an option)
        if (hasAnswered) return;
        hasAnswered = true;

        clearInterval(timerInterval);
        clearTimeout(autoAdvanceTimeout);

        const currentQuestion = questions[currentQuestionIndex];
        const optionButtons   = optionsContainer.querySelectorAll("button");

        // Lock all option buttons
        optionButtons.forEach(btn => {
            btn.disabled            = true;
            btn.style.pointerEvents = "none";
        });

        userAnswers.push({
            questionIndex: currentQuestionIndex,
            selectedIndex,
            correctIndex: currentQuestion.answer
        });

        if (selectedIndex === currentQuestion.answer) {
            // Correct answer
            userScore++;
            optionButtons[selectedIndex].classList.add("btn-success");
        } else if (selectedIndex === TIMEOUT_ANSWER || selectedIndex === SKIP_ANSWER) {
            // Timed out or skipped — just reveal the correct answer, no red highlight
            optionButtons[currentQuestion.answer].classList.add("btn-success");
        } else {
            // Wrong answer — highlight wrong in red and correct in green
            optionButtons[selectedIndex].classList.add("btn-danger");
            optionButtons[currentQuestion.answer].classList.add("btn-success");
        }

        progressBar.style.width = `${((currentQuestionIndex + 1) / questions.length) * 100}%`;

        // Auto-advance after a short pause (user can also click Next manually)
        autoAdvanceTimeout = setTimeout(() => {
            advanceToNextQuestion();
        }, 1000);
    }

    // ================================================================
    // 12. advanceToNextQuestion()
    // If the user clicks Next before answering, record it as a skip.
    // ================================================================
    function advanceToNextQuestion() {
        if (isAdvancing) return;
        isAdvancing = true;

        clearTimeout(autoAdvanceTimeout);

        // User pressed Next without selecting any answer — record as skipped
        if (!hasAnswered) {
            handleSelection(SKIP_ANSWER);
            // handleSelection will trigger its own auto-advance; bail here
            // to avoid double-advancing. Reset isAdvancing so the deferred
            // call from handleSelection can proceed.
            isAdvancing = false;
            return;
        }

        currentQuestionIndex++;

        if (currentQuestionIndex < questions.length) {
            loadQuestion();
        } else {
            showResults(questions);
        }
    }

    // ================================================================
    // 13. resetTimer() / startTimer()
    // ================================================================
    function resetTimer() {
        clearInterval(timerInterval);
        timeLeft = 10;
        timerDisplay.textContent = `${timeLeft}s`;
        timerDisplay.style.color = "var(--primary)";
        startTimer();
    }

    function startTimer() {
        timerInterval = setInterval(() => {
            timeLeft--;
            timerDisplay.textContent = `${timeLeft}s`;

            if (timeLeft <= 5) {
                timerDisplay.style.color = "var(--danger)";
            }

            if (timeLeft <= 0) {
                clearInterval(timerInterval);
                handleSelection(TIMEOUT_ANSWER);
            }
        }, 1000);
    }

    // ================================================================
    // 14. showResults(resultQuestions)
    // Stat pills and card states distinguish correct / wrong /
    // skipped (manual) / timed-out separately.
    // ================================================================
    function showResults(resultQuestions) {
        clearInterval(timerInterval);
        showPanel("results");
        progressBar.style.width = "100%";

        const scorePercentage = Math.round((userScore / resultQuestions.length) * 100);

        // ── Back to Portfolio button ─────────────────────────────────
        let backBtn = document.getElementById("results-back-btn");
        if (!backBtn) {
            backBtn = document.createElement("a");
            backBtn.id        = "results-back-btn";
            backBtn.href      = "../index.html";
            backBtn.className = "btn btn-outline-secondary btn-sm";
            backBtn.style.cssText = "position:absolute; top:0.75rem; left:0.75rem; font-size:0.78rem; z-index:10;";
            backBtn.innerHTML = "&larr; Back to Portfolio";
            resultsPanel.style.position = "relative";
            resultsPanel.prepend(backBtn);
        }

        // Push the hero content down so the back button doesn't overlap it
        const resultsHero = document.getElementById("results-hero");
        if (resultsHero) resultsHero.style.paddingTop = "3rem";

        // ── Score ring ──────────────────────────────────────────────
        scorePercent.textContent = scorePercentage;
        const ring = document.getElementById("score-ring");
        if (ring) ring.style.setProperty("--pct", `${scorePercentage}%`);

        // ── Emoji + message ─────────────────────────────────────────
        if (scorePercentage === 100) {
            resultEmoji.textContent = "🏆";
            scoreText.textContent   = "Perfect score — outstanding!";
        } else if (scorePercentage >= 80) {
            resultEmoji.textContent = "🎉";
            scoreText.textContent   = "Excellent — you have a strong grasp of this topic.";
        } else if (scorePercentage >= 60) {
            resultEmoji.textContent = "👍";
            scoreText.textContent   = "Good effort — you passed!";
        } else {
            resultEmoji.textContent = "📚";
            scoreText.textContent   = "Keep at it — review the explanations below.";
        }

        // ── Stat pills ───────────────────────────────────────────────
        const timedOutCount = userAnswers.filter(a => a.selectedIndex === TIMEOUT_ANSWER).length;
        const skippedCount  = userAnswers.filter(a => a.selectedIndex === SKIP_ANSWER).length;
        const wrongCount    = resultQuestions.length - userScore - timedOutCount - skippedCount;

        const statPills = document.getElementById("stat-pills");
        if (statPills) {
            statPills.innerHTML = `
                <span class="stat-pill correct">✓ ${userScore} correct</span>
                <span class="stat-pill wrong">✗ ${wrongCount} wrong</span>
                ${skippedCount  > 0 ? `<span class="stat-pill skipped">⏭ ${skippedCount} skipped</span>` : ""}
                ${timedOutCount > 0 ? `<span class="stat-pill skipped">⏱ ${timedOutCount} timed out</span>` : ""}
            `;
        }

        // ── Question cards ───────────────────────────────────────────
        scoreBreakdown.innerHTML = "";
        resultQuestions.forEach((q, indx) => {
            const userAns    = userAnswers[indx];
            const timedOut   = userAns && userAns.selectedIndex === TIMEOUT_ANSWER;
            const skipped    = userAns && userAns.selectedIndex === SKIP_ANSWER;
            const isCorrect  = userAns && userAns.selectedIndex === userAns.correctIndex;

            const cardState  = isCorrect ? "q-correct" : (timedOut || skipped) ? "q-skipped" : "q-wrong";
            const badgeState = isCorrect ? "badge-correct" : (timedOut || skipped) ? "badge-skipped" : "badge-wrong";
            const badgeLabel = isCorrect ? "Correct" : timedOut ? "Timed out" : skipped ? "Skipped" : "Wrong";

            const yourAnswerText = timedOut
                ? "No answer (timed out)"
                : skipped
                    ? "Skipped"
                    : !userAns
                        ? "N/A"
                        : q.options[userAns.selectedIndex];

            const yourAnswerClass = isCorrect ? "correct-val" : "yours-wrong";

            const li = document.createElement("li");
            li.innerHTML = `
                <div class="q-card ${cardState}">
                    <div class="q-card-header">
                        <span class="q-num">Q${indx + 1}</span>
                        <span class="q-badge ${badgeState}">${badgeLabel}</span>
                    </div>
                    <p class="q-question mb-0">${q.question}</p>
                    <div class="q-answers mt-2">
                        <div class="q-answer-row">
                            <span class="q-answer-label">Your answer</span>
                            <span class="q-answer-value ${yourAnswerClass}">${yourAnswerText}</span>
                        </div>
                        ${!isCorrect ? `
                        <div class="q-answer-row">
                            <span class="q-answer-label">Correct answer</span>
                            <span class="q-answer-value correct-val">${q.options[q.answer]}</span>
                        </div>` : ""}
                    </div>
                    <div class="q-explanation" id="explanation-${indx}">
                        <span class="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span>
                        <span class="fst-italic">Loading explanation&hellip;</span>
                    </div>
                </div>
            `;
            scoreBreakdown.appendChild(li);
        });

        // ── AI explanations (deferred until visible) ─────────────────
        const explanationInputs = resultQuestions.map(q => ({
            question: q.question,
            answer: q.options[q.answer]
        }));

        function applyExplanations(explanations) {
            resultQuestions.forEach((q, indx) => {
                const el = document.getElementById(`explanation-${indx}`);
                if (!el) return;
                el.innerHTML = "";
                const text = explanations && explanations[indx];
                if (text) {
                    const label = document.createElement("strong");
                    label.textContent = "Why: ";
                    el.appendChild(label);
                    el.appendChild(document.createTextNode(text));
                } else {
                    el.innerHTML = `
                        <span class="fst-italic me-2">Explanation unavailable.</span>
                        <button class="btn btn-link btn-sm p-0 retry-explanation-btn"
                                data-index="${indx}" style="font-size:0.78rem;">Retry</button>
                    `;
                }
            });

            scoreBreakdown.querySelectorAll(".retry-explanation-btn").forEach(btn => {
                btn.addEventListener("click", async () => {
                    const i  = parseInt(btn.dataset.index, 10);
                    const el = document.getElementById(`explanation-${i}`);
                    if (!el) return;
                    el.innerHTML = `<span class="spinner-border spinner-border-sm me-1" role="status"></span>
                                    <span class="fst-italic">Retrying&hellip;</span>`;
                    const single = await fetchAllExplanations([explanationInputs[i]]);
                    el.innerHTML = "";
                    if (single && single[0]) {
                        const label = document.createElement("strong");
                        label.textContent = "Why: ";
                        el.appendChild(label);
                        el.appendChild(document.createTextNode(single[0]));
                    } else {
                        el.innerHTML = `<span class="text-danger small">Still unavailable — try again later.</span>`;
                    }
                });
            });
        }

        function loadExplanations() {
            fetchAllExplanations(explanationInputs).then(applyExplanations);
        }

        if ("IntersectionObserver" in window) {
            const observer = new IntersectionObserver(entries => {
                if (entries[0].isIntersecting) {
                    observer.disconnect();
                    loadExplanations();
                }
            }, { threshold: 0.1 });
            observer.observe(scoreBreakdown);
        } else {
            loadExplanations();
        }
    }

    // ================================================================
    // EVENT LISTENERS
    // ================================================================
    nextBtn.addEventListener("click", advanceToNextQuestion);

    // ================================================================
    // KICK OFF
    // ================================================================
    renderTopicCards();
    updateStartButtonState();
    showPanel("setup");

    quizContainer.style.display = "block";
    quizContainer.classList.add("fade-in");
});