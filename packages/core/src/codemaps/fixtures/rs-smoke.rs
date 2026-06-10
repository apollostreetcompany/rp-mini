use std::fmt;

pub struct Task {
    id: String,
    title: String,
}

impl Task {
    pub fn new(id: String, title: String) -> Self {
        Self { id, title }
    }

    pub fn rename(&mut self, title: String) {
        self.title = title;
    }
}

impl fmt::Display for Task {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.title)
    }
}

pub fn default_task() -> Task {
    Task::new("1".to_string(), "Inbox".to_string())
}
