"""Compile a fixed-volume audience recipe from an operator-reviewed protocol."""
from __future__ import annotations

import copy
import math

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator

COMPONENTS = ("red", "yellow", "blue")
TOTAL_VOLUME_UL = 150
VOLUME_STEP_UL = 5
COMMANDS = ["pick_up_tip", "transfer", "drop_tip"] * 2 + ["pick_up_tip", "transfer", "mix", "drop_tip"]


class MixtureSetup(BaseModel):
    model_config = ConfigDict(extra="forbid")
    gantry_file: str = Field(min_length=1)
    deck_file: str = Field(min_length=1)
    source_protocol_file: str = Field(min_length=1)
    fluid_state_id: int = Field(gt=0, strict=True)
    candidate_wells: list[str] = Field(min_length=1, max_length=96)

    @field_validator("candidate_wells")
    @classmethod
    def unique_wells(cls, value):
        if any(not well or not isinstance(well, str) for well in value) or len(set(value)) != len(value):
            raise ValueError("Candidate wells must be nonempty and distinct")
        return value


def validated_volumes(recipe: dict) -> dict[str, int]:
    parts = recipe["parts"]
    if any(type(parts.get(name)) is not int or not 0 <= parts[name] <= 10 for name in COMPONENTS):
        raise ValueError("Recipe parts must be integers between 0 and 10")
    total = sum(parts[name] for name in COMPONENTS)
    if total == 0:
        raise ValueError("The recipe must contain a dye")
    exact = [parts[name] * (TOTAL_VOLUME_UL // VOLUME_STEP_UL) / total for name in COMPONENTS]
    units = [math.floor(value) for value in exact]
    order = sorted(range(3), key=lambda i: (-(exact[i] - units[i]), i))
    for i in order[:TOTAL_VOLUME_UL // VOLUME_STEP_UL - sum(units)]:
        units[i] += 1
    expected = dict(zip(COMPONENTS, (value * VOLUME_STEP_UL for value in units)))
    if recipe.get("totalVolumeUl") != TOTAL_VOLUME_UL or recipe.get("volumes") != expected:
        raise ValueError("Recipe volumes do not match its fixed-volume proportions")
    return expected


def source_steps(source: str) -> list[dict]:
    try:
        document = yaml.safe_load(source)
    except yaml.YAMLError as exc:
        raise ValueError("Cannot parse the reviewed mixture template") from exc
    if not isinstance(document, dict) or set(document) != {"protocol"}:
        raise ValueError("Mixture template must contain only a protocol list")
    steps = document["protocol"]
    if not isinstance(steps, list) or [next(iter(s)) if isinstance(s, dict) and len(s) == 1 else None for s in steps] != COMMANDS:
        raise ValueError("Use a reviewed three-stock transfer template with one final mix and no camera or other steps")
    for step in steps:
        if not isinstance(next(iter(step.values())), dict):
            raise ValueError("Every template step requires arguments")
    for i in (1, 4, 7):
        if not all(key in steps[i]["transfer"] for key in ("source", "destination", "volume_ul")):
            raise ValueError("Each transfer requires a source, destination and volume")
    mix = steps[8]["mix"]
    if not all(key in mix for key in ("position", "volume_ul", "cycles", "height")):
        raise ValueError("The reviewed mix requires position, volume, cycles and height")
    if not isinstance(mix["volume_ul"], (int, float)) or not 0 < mix["volume_ul"] <= TOTAL_VOLUME_UL:
        raise ValueError("Mix volume must fit inside the 150 uL sample")
    return steps


def compile_mixture(source: str, recipe: dict, well: str, available_tips: list[str]) -> tuple[str, dict[str, float]]:
    volumes = validated_volumes(recipe)
    templates = source_steps(source)
    active = [(i, name) for i, name in enumerate(COMPONENTS) if volumes[name] > 0]
    if len(available_tips) < len(active) or len(set(available_tips)) != len(available_tips):
        raise ValueError("Insufficient distinct fresh tips for this recipe")
    steps = []
    required_stock: dict[str, float] = {}
    for index, (component_index, name) in enumerate(active):
        pickup = copy.deepcopy(templates[component_index * 3])
        pickup["pick_up_tip"]["position"] = available_tips[index]
        transfer = copy.deepcopy(templates[component_index * 3 + 1])
        transfer["transfer"].update(destination=well, volume_ul=volumes[name])
        source_position = transfer["transfer"]["source"]
        required_stock[source_position] = required_stock.get(source_position, 0) + volumes[name]
        steps.extend((pickup, transfer))
        if index == len(active) - 1:
            mix = copy.deepcopy(templates[8])
            mix["mix"]["position"] = well
            steps.append(mix)
            drop = templates[9]
        else:
            drop = templates[component_index * 3 + 2]
        steps.append(copy.deepcopy(drop))
    return yaml.safe_dump({"protocol": steps}, sort_keys=False), required_stock


def check_inventory(snapshot: dict, well: str, required_stock: dict[str, float]):
    containers = {f"{item['labware_key']}.{item['location_id']}" if item["location_id"] else item["labware_key"]: item
                  for item in snapshot["containers"]}
    destination = containers.get(well)
    if destination is None or float(destination["current_volume_ul"]) != 0:
        raise ValueError("The selected well is missing or is not empty in CubOS inventory")
    for source, required in required_stock.items():
        item = containers.get(source)
        if item is None or "dead_volume_ul" not in item:
            raise ValueError("CubOS must provide current stock and dead-volume information")
        usable = float(item["current_volume_ul"]) - float(item["dead_volume_ul"])
        if not math.isfinite(usable) or usable < required:
            raise ValueError(f"Insufficient usable stock at {source}")
