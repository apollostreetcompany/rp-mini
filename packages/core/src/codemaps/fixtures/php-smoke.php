<?php

namespace App\Tasks;

use App\Support\Clock;

interface TaskRepository
{
    public function find(string $id): ?Task;
}

trait HasTaskTitle
{
    public function title(): string
    {
        return $this->title;
    }
}

enum TaskStatus
{
    case Open;
    case Closed;
}

class Task
{
    use HasTaskTitle;

    public string $id;
    private string $title;

    public function __construct(string $id, string $title)
    {
        $this->id = $id;
        $this->title = $title;
    }

    public static function draft(string $title): self
    {
        return new self('draft', $title);
    }
}

function task_label(Task $task): string
{
    return $task->title();
}
