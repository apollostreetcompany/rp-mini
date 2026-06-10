using System.Collections.Generic;

namespace Example.Tasks;

public interface ITaskRepository
{
    IReadOnlyList<Task> All();
    void Save(Task task);
}

public enum TaskStatus
{
    Open,
    Closed
}

public class Task
{
    public string Id { get; }
    public string Title { get; private set; }

    public Task(string id, string title)
    {
        Id = id;
        Title = title;
    }

    public string Label() => $"{Id}:{Title}";

    public void Rename(string title)
    {
        Title = title;
    }
}
