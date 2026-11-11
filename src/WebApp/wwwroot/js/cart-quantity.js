// Cart quantity: commit a directly-typed quantity immediately, without an Update
// button. The [-] / [+] / Remove buttons already submit on their own (they are real
// submit buttons inside the enhanced-navigation form), so this only enhances typing:
// on change (or Enter) we copy the typed value into the hidden apply submitter and
// request a submit, letting Blazor's enhanced form post update the basket in place.
//
// Delegated from document and safe to load once; no per-element wiring, so it keeps
// working after enhanced-navigation morphs the DOM.
(function () {
    'use strict';

    // Value each input last committed with Enter. Enter leaves the input focused, so the
    // next click elsewhere (e.g. on [-]) blurs it and the browser fires `change` for the
    // same typed value; without this check that change re-submits the typed quantity in
    // parallel with the button's own POST and Redis can end up on the typed value.
    // A WeakMap (not a data- attribute) so enhanced-navigation DOM morphing can't drop it.
    var enterCommitted = new WeakMap();

    function quantityInput(e) {
        return e.target.closest && e.target.closest('[data-cart-quantity-input]');
    }

    function commit(input) {
        var form = input.closest('form');
        if (!form) {
            return null;
        }

        var apply = form.querySelector('[data-cart-quantity-apply]');
        if (!apply) {
            return null;
        }

        var value = parseInt(input.value, 10);
        if (!isFinite(value) || value < 1) {
            value = 1;
        }
        input.value = String(value);

        apply.value = String(value);
        if (typeof form.requestSubmit === 'function') {
            form.requestSubmit(apply);
        } else {
            apply.click();
        }
        return input.value;
    }

    document.addEventListener('change', function (e) {
        var input = quantityInput(e);
        if (!input) {
            return;
        }
        var committed = enterCommitted.get(input);
        enterCommitted.delete(input);
        if (committed !== undefined && committed === input.value) {
            // Already submitted by Enter; this is just the blur after it.
            return;
        }
        commit(input);
    });

    // Typing again after an Enter-commit means the next change carries a new value.
    document.addEventListener('input', function (e) {
        var input = quantityInput(e);
        if (input) {
            enterCommitted.delete(input);
        }
    });

    // Enter should apply the typed value rather than trigger the first submit button
    // (which would be the decrement). Prevent the default submit, commit, and remember
    // the committed value so the blur-triggered change doesn't submit it again.
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') {
            return;
        }
        var input = quantityInput(e);
        if (input) {
            e.preventDefault();
            var committed = commit(input);
            if (committed !== null) {
                enterCommitted.set(input, committed);
            }
        }
    });
})();
