"""Automatic passages (passages.py) on made-up geometry: a bridge over a street, a keep with storeys, a navmesh."""

from __future__ import annotations

import numpy as np

from atlas_gamefiles import passages
from atlas_gamefiles.floors import locate, plan_floors, prepare

import fixtures


def floor_at(plan, x: float, y: float, z: float) -> int:
    return locate(plan, x, y + 0.5, z).floor


def test_bridge_is_shown_over_the_passage_under_it() -> None:
    triangles = np.asarray(fixtures.bridge_over_street(), dtype=np.float32)
    plan = passages.plan_passages(triangles)
    assert plan.method == "passages"
    assert plan.cuts == []
    report = plan.report["passages"]
    assert report["levels"] == 2
    assert len(report["places"]) == 1
    place = report["places"][0]
    assert 20 <= place["x"] <= 40 and 26 <= place["z"] <= 34
    assert place["levels"] == 2 and place["show"] == "upper" and not place["set"]
    # The bridge is on the main floor with the street round it; only the passage under it is a floor below.
    assert plan.main == 1
    assert floor_at(plan, 30, 8, 30) == 1
    assert floor_at(plan, 30, 0, 30) == 0
    assert floor_at(plan, 30, 0, 0) == 1
    assert floor_at(plan, 30, 0, 80) == 1
    assert floor_at(plan, 50, 8, 30) == 1
    assert plan.floors[0].area < 250
    assert plan.heights == [[0.0, 0.0], [0.0, 8.0]]


def test_lower_shows_the_passage_and_lifts_the_bridge() -> None:
    triangles = np.asarray(fixtures.bridge_over_street(), dtype=np.float32)
    prep = passages.prepare_passages(triangles)
    plan = passages.plan_passages(prep, overrides={"passages": [{"x": 31.2, "z": 28.0, "show": "lower"}]})
    place = plan.report["passages"]["places"][0]
    assert place["show"] == "lower" and place["set"]
    assert plan.main == 0
    assert floor_at(plan, 30, 0, 30) == 0
    assert floor_at(plan, 30, 8, 30) == 1
    assert floor_at(plan, 50, 8, 30) == 0
    assert plan.floors[1].area < 250
    # A choice far from every place is left out.
    other = passages.plan_passages(prep, overrides={"passages": [{"x": 500, "z": 500, "show": "lower"}]})
    assert other.report["passages"]["choicesUsed"] == 0
    assert other.main == 1


def test_ramps_and_stairs_stay_one_surface() -> None:
    triangles = np.asarray(fixtures.bridge_over_street(), dtype=np.float32)
    plan = passages.plan_passages(triangles)
    for x, y, z in ((50, 4, -20), (10, 2, -30), (50, 6, 70), (50, 0, -45)):
        assert floor_at(plan, x, y, z) == plan.main


def test_a_keep_gets_a_floor_per_storey() -> None:
    triangles, markers = fixtures.made_up_keep()
    plan = passages.plan_passages(np.asarray(triangles, dtype=np.float32))
    assert plan.main == 0
    assert len(plan.floors) == 4
    floors = {category + str(round(y)): floor_at(plan, x, y, z) for (x, y, z), category in markers}
    assert floors["bonfire0"] == 0 and floors["ring-3"] == 0 and floors["weapon0"] == 0
    assert floors["armour5"] == 1 and floors["key5"] == 1
    assert floors["spell10"] == 2
    assert floors["boss15"] == 3
    assert len(plan.wall_lines) == 4


def test_navmesh_support_drops_short_cuts_and_unwalked_roofs() -> None:
    ground = fixtures.slab(0, 40, 0, 40, 0.0)
    roof = fixtures.slab(10, 30, 10, 30, 6.0)
    triangles = np.asarray(ground + roof, dtype=np.float32)
    without = passages.plan_passages(triangles)
    assert len(without.report["passages"]["places"]) == 1
    # The navmesh covers the ground only, plus a triangle floating over it (no collision under it).
    nav = np.asarray(fixtures.slab(0, 40, 0, 40, 0.1, step=4.0) + [[(5, 3.0, 5), (5, 3.0, 9), (9, 3.0, 5)]], dtype=np.float32)
    prep = passages.prepare_passages(triangles, nav)
    assert prep.nav["triangles"] == len(nav)
    assert prep.nav["kept"] == len(nav) - 1
    plan = passages.plan_passages(prep)
    assert plan.report["passages"]["places"] == []
    assert len(plan.floors) == 1


def test_support_navmesh_needs_the_centre_and_two_corners() -> None:
    prepared = prepare(
        np.asarray(fixtures.slab(0, 10, 0, 10, 0.0), dtype=np.float32)
    )
    nav = np.asarray(
        [
            [(1, 0, 1), (1, 0, 3), (3, 0, 1)],  # on the ground
            [(1, 0, 1), (1, 5, 3), (3, 5, 1)],  # two corners up in the air
            [(1, 0.8, 1), (1, 0.8, 3), (3, 0.8, 1)],  # within reach
        ],
        dtype=np.float32,
    )
    assert passages.support_navmesh(prepared, nav, 1.2).tolist() == [True, False, True]


def test_small_overlaps_are_left_alone() -> None:
    ground = fixtures.slab(0, 40, 0, 40, 0.0)
    shelf = fixtures.slab(10, 12, 10, 12, 4.0)
    plan = passages.plan_passages(np.asarray(ground + shelf, dtype=np.float32))
    assert plan.report["passages"]["places"] == []


def test_settings_and_empty_input() -> None:
    assert passages.passage_settings({"band": 2, "overlap": True, "navSupport": -1})["band"] == 2.0
    assert passages.passage_settings({"overlap": True})["overlap"] == 2.4
    empty = passages.plan_passages(np.zeros((0, 3, 3), dtype=np.float32))
    assert empty.floors == [] and empty.method == "passages"


def test_cuts_and_passages_agree_where_nothing_overlaps() -> None:
    triangles = np.asarray(fixtures.slab(0, 30, 0, 30, 0.0) + fixtures.ramp(30, 40, 0, 30, 0.0, 6.0), dtype=np.float32)
    assert len(plan_floors(triangles).floors) == 1
    assert len(passages.plan_passages(triangles).floors) == 1
