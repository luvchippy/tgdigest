from dataclasses import dataclass, field


@dataclass
class Message:
    channel: str
    msg_id: int
    posted_at: str
    text: str
    html: str
    links: list[str] = field(default_factory=list)
    has_media: bool = False
    has_buttons: bool = False
    forward_from: str | None = None

    @property
    def key(self) -> str:
        return f"{self.channel}/{self.msg_id}"

    @property
    def primary_link(self) -> str | None:
        return self.links[0] if self.links else None
