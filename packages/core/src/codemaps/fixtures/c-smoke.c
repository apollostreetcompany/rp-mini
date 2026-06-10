#include <stddef.h>

#define TASK_LIMIT 32

typedef size_t TaskCount;

struct Task {
    int id;
    const char *title;
};

enum TaskStatus {
    TASK_OPEN,
    TASK_CLOSED,
};

int default_task_id = 1;

int add(int lhs, int rhs) {
    return lhs + rhs;
}
