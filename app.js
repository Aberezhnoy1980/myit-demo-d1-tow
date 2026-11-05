/* «Тяга» — поведение демо-страницы. Без фреймворков.
   Без JS страница остаётся читаемой: черновик обращения с атрибутом open
   показывается как обычный блок, кнопки связи честно отключены.

   Семантика: «настроен» = техническая настройка ссылки контакта.
   Это не доказательство доставки и не признак действующего бизнеса. */
(function () {
  "use strict";

  var APPLIED = false;

  function validTel(value) {
    return typeof value === "string" && /^tel:\+[0-9][0-9\s()\-]{4,}$/.test(value.trim());
  }

  function validHttps(value) {
    if (typeof value !== "string" || value.trim() === "") return false;
    try {
      var u = new URL(value.trim());
      return u.protocol === "https:";
    } catch (e) {
      return false;
    }
  }

  /* ---------- элементы ---------- */
  function $(id) { return document.getElementById(id); }

  var memo = $("memo");
  var memoStatus = $("memo-status");
  var memoText = $("memo-text");
  var lastTrigger = null;

  /* ---------- диалог ---------- */
  function openMemo(trigger) {
    lastTrigger = trigger || document.activeElement;
    if (typeof memo.showModal === "function") {
      if (!memo.open) memo.showModal();
    } else {
      memo.setAttribute("open", "");
    }
    var copyBtn = $("memo-copy");
    if (copyBtn) copyBtn.focus();
  }

  function closeMemo() {
    if (memo.open) memo.close();
  }

  function wireDialog() {
    if (APPLIED) return;
    APPLIED = true;
    if (memo.open) memo.close();

    $("memo-close").addEventListener("click", closeMemo);
    $("memo-close2").addEventListener("click", closeMemo);

    /* Закрытия по backdrop/клику на пустом поле диалога НЕТ:
       закрывается только Esc, кнопками «✕» и «Закрыть». */
    memo.addEventListener("close", function () {
      if (lastTrigger && typeof lastTrigger.focus === "function") {
        lastTrigger.focus();
      }
      if (memoStatus) memoStatus.textContent = "";
    });

    /* фокус-трап внутри модального окна */
    memo.addEventListener("keydown", function (e) {
      if (e.key !== "Tab") return;
      var focusables = memo.querySelectorAll("button, a[href], textarea");
      if (focusables.length === 0) return;
      var first = focusables[0];
      var lastEl = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        first.focus();
      }
    });

    var openMemoBtn = $("open-memo");
    if (openMemoBtn) {
      openMemoBtn.addEventListener("click", function () { openMemo(openMemoBtn); });
    }

    /* ---------- копирование текста обращения ---------- */
    function fallbackCopy() {
      var ok = false;
      memoText.focus();
      memoText.select();
      try {
        ok = document.execCommand("copy");
      } catch (e) {
        ok = false;
      }
      if (!ok) {
        memoStatus.textContent = "Автоматически скопировать не удалось. Текст выделен — нажмите Ctrl+C (Windows) или ⌘C (Mac) и вставьте в сообщение.";
        return false;
      }
      return true;
    }

    var copyBtn = $("memo-copy");
    if (copyBtn && memoText) {
      copyBtn.addEventListener("click", function () {
        var text = memoText.value;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () {
            memoStatus.textContent = "Текст скопирован. Вставьте его в сообщение диспетчеру и заполните пустые строки.";
          }).catch(function () {
            if (fallbackCopy()) {
              memoStatus.textContent = "Текст скопирован. Вставьте его в сообщение диспетчеру и заполните пустые строки.";
            }
          });
        } else {
          if (fallbackCopy()) {
            memoStatus.textContent = "Текст скопирован. Вставьте его в сообщение диспетчеру и заполните пустые строки.";
          }
        }
      });
    }
  }

  /* ---------- главные CTA: один сценарий для шапки и hero ---------- */
  function makeCta(el, contact) {
    var base = "btn btn-primary" + (el.id === "header-cta" ? " btn-small" : "");
    var btn;
    if (contact) {
      btn = document.createElement("a");
      btn.href = contact.href;
      btn.textContent = contact.label;
      btn.className = base;
    } else {
      btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Попробовать обращение";
      btn.className = base;
      btn.addEventListener("click", function () { openMemo(btn); });
    }
    btn.id = el.id;
    btn.setAttribute("data-cta", "");
    el.replaceWith(btn);
    return btn;
  }

  /* ---------- применение конфигурации ---------- */
  function apply(cfg) {
    cfg = cfg || {};
    var phone = validTel(cfg.phone) ? cfg.phone.trim() : null;
    var messenger = validHttps(cfg.messenger) ? cfg.messenger.trim() : null;
    if (cfg.phone !== null && cfg.phone !== undefined && cfg.phone !== "" && !phone) {
      console.warn("config: phone не прошёл проверку URL (ожидается tel:+…). Кнопка остаётся не настроенной.");
    }
    if (cfg.messenger !== null && cfg.messenger !== undefined && cfg.messenger !== "" && !messenger) {
      console.warn("config: messenger не прошёл проверку URL (ожидается https://…). Кнопка остаётся не настроенной.");
    }

    var recipient = (typeof cfg.recipient === "string" && cfg.recipient.trim() !== "")
      ? cfg.recipient.trim() : "Диспетчер";

    /* главный контакт: телефон приоритетнее мессенджера */
    var primary = phone ? { href: phone, label: "Позвонить диспетчеру" }
      : (messenger ? { href: messenger, label: "Написать диспетчеру" } : null);

    /* CTA шапки и hero — один сценарий */
    var ctaElements = document.querySelectorAll("[data-cta]");
    for (var i = 0; i < ctaElements.length; i++) {
      makeCta(ctaElements[i], primary);
    }

    /* пояснение перед демонстрационным действием */
    var heroNote = $("hero-note");
    if (heroNote) {
      heroNote.textContent = primary
        ? "Кнопка откроет приложение звонков или мессенджер — сообщение вы отправляете сами. Контакт настроен для демонстрации, отправка не выполняется автоматически."
        : "Кнопка откроет черновик обращения: скопируйте текст и заполните его своими данными. Отправка в демо не выполняется.";
    }

    /* заголовок раздела контакта соответствует фактическому поведению */
    var contactTitle = $("contact-title");
    if (contactTitle) {
      contactTitle.textContent = primary ? "Связаться с диспетчером" : "Попробовать обращение";
    }

    /* видимое действие черновика в разделе контакта:
       empty/invalid — главное действие раздела; configured — вторичное
       действие подготовки сообщения рядом с настроенными контактами */
    var draft = $("contact-draft");
    if (draft) {
      var db = document.createElement("button");
      db.type = "button";
      db.id = "contact-draft";
      db.setAttribute("data-draft", "");
      db.className = primary ? "btn btn-secondary" : "btn btn-primary";
      db.textContent = primary ? "Открыть черновик обращения" : "Попробовать обращение";
      db.addEventListener("click", function () { openMemo(db); });
      draft.replaceWith(db);
    }

    /* вводный текст раздела контакта */
    var intro = $("contact-intro");
    if (intro) {
      intro.textContent = primary
        ? "Способы связи настроены для демонстрации. Кнопка открывает приложение — само сообщение вы отправляете сами, страница ничего не отправляет."
        : "Контакты в этом демо не настроены, поэтому доступно действие «Попробовать обращение»: черновик текста с подсказками внутри. Отправка в демо не выполняется.";
    }

    /* подписи получателя — только при настроенном контакте */
    var recips = document.querySelectorAll("[data-recipient]");
    for (var r = 0; r < recips.length; r++) {
      recips[r].textContent = "Получатель: " + recipient;
      recips[r].hidden = !primary;
    }

    /* карточки связи */
    function wireSlot(kind, value, label, statusId, statusText) {
      var slot = $("slot-" + kind);
      var status = $(statusId);
      if (value) {
        var a = document.createElement("a");
        a.className = "btn btn-contact";
        a.href = value;
        a.textContent = label;
        slot.replaceChildren(a);
        if (status) status.textContent = statusText;
      } else {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "btn btn-contact";
        b.disabled = true;
        b.setAttribute("data-contact", kind);
        b.textContent = kind === "phone" ? "Телефон не настроен" : "Мессенджер не настроен";
        slot.replaceChildren(b);
        if (status) status.textContent = "В демо этот способ не настроен. Доступен черновик обращения.";
      }
    }
    wireSlot("phone", phone, "Позвонить диспетчеру", "phone-status", "Кнопка откроет приложение звонков.");
    wireSlot("messenger", messenger, "Написать в мессенджер", "messenger-status", "Кнопка откроет мессенджер. Текст черновика можно скопировать ниже.");
  }

  /* ---------- инициализация ---------- */
  wireDialog();
  apply(window.DEMO_CONTACTS || {});

  window.TOW = { apply: apply };
})();
