from baseline_ai.ots_compat import inspect_ots_batch


def test_ots_batch_detects_rejection_before_request():
    batch = inspect_ots_batch(
        [
            [">battle-test"],
            ["The opponent rejected open team sheets."],
            ["", "request", '{"teamPreview":true}'],
        ]
    )
    assert batch.room_id == "battle-test"
    assert batch.saw_request
    assert batch.saw_rejection
    assert batch.rejection_preceded_request
    assert not batch.plain_rejection_followed_request


def test_ots_batch_distinguishes_upstream_handled_order():
    batch = inspect_ots_batch(
        [
            [">battle-test"],
            ["", "request", '{"teamPreview":true}'],
            ["The opponent rejected open team sheets."],
        ]
    )
    assert batch.plain_rejection_followed_request
    assert not batch.rejection_preceded_request


def test_ots_batch_recognizes_error_variant():
    batch = inspect_ots_batch(
        [[">battle-test"], ["", "error", "The opponent rejected open team sheets."]]
    )
    assert batch.saw_error_rejection
    assert batch.saw_rejection
