"""Application-owned settings; station configuration remains in CubOS."""
from pathlib import Path
from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class LearningSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="URSA_LEARNING_", extra="ignore", validate_assignment=True)
    host: str = "127.0.0.1"
    port: int = 8750
    open_browser: bool = True
    cubos_url: str = "http://127.0.0.1:8742"
    cubos_api_token: SecretStr | None = None
    cubos_api_token_file: Path | None = None
    api_token: SecretStr | None = None
    api_token_file: Path | None = None
    config_dir: Path = Path.home() / ".ursa-learning" / "configs"
    run_dir: Path = Path.home() / ".ursa-learning" / "runs"
    trusted_hosts: list[str] = Field(default_factory=list)
    request_timeout: float = 30.0

    @property
    def configs_dir(self) -> Path:
        return self.ensure_config_dir()

    def ensure_config_dir(self) -> Path:
        path = self.config_dir.expanduser().resolve()
        for category in ("gantry", "deck", "protocol", "campaign"):
            (path / category).mkdir(parents=True, exist_ok=True)
        return path

    def ensure_run_dir(self) -> Path:
        path = self.run_dir.expanduser().resolve()
        path.mkdir(parents=True, exist_ok=True)
        return path

    def resolved_api_token(self) -> SecretStr | None:
        return self._token(self.api_token, self.api_token_file)

    def resolved_cubos_token(self) -> SecretStr | None:
        return self._token(self.cubos_api_token, self.cubos_api_token_file)

    @staticmethod
    def _token(value, file):
        if value is not None:
            return value
        if file is None:
            return None
        token = file.expanduser().read_text(encoding="utf-8").strip()
        if not token:
            raise ValueError("Configured token file is empty")
        return SecretStr(token)


# Compatibility name while extracted campaign code moves to application settings.
CubOSSettings = LearningSettings
_settings = LearningSettings()


def get_settings() -> LearningSettings:
    return _settings
